"""Stage 4 (GPU, runs on Modal): gsplat training with the MCMC strategy.

Follows gsplat 1.5.3's examples/simple_trainer.py MCMC defaults (init opacity 0.5, init
scale 0.1 x kNN distance, opacity/scale regularisers 0.01, Adam with eps 1e-15, means LR
1.6e-4 x scene scale decayed 100x, SH degree +1 every 1000 steps, loss 0.8 L1 + 0.2 D-SSIM).

The scene is already floor-levelled and metric, so the trained splat is in the output frame.
torch / gsplat are imported inside functions: this module imports on a laptop without them.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING, Any

import numpy as np

from .scene import Scene
from .splat_ply import Splats

if TYPE_CHECKING:
    import torch


@dataclass(frozen=True)
class TrainConfig:
    iters: int = 30_000
    cap_max: int = 3_000_000
    sh_degree: int = 3
    sh_degree_interval: int = 1000
    init_opacity: float = 0.5
    init_scale: float = 0.1
    opacity_reg: float = 0.01
    scale_reg: float = 0.01
    # Needle penalty: Gaussians whose longest axis exceeds max_aniso x their middle axis show up
    # as shards ("crystals") from viewpoints off the recorded path. Flat discs (walls) stay free.
    aniso_reg: float = 0.1
    max_aniso: float = 5.0
    ssim_lambda: float = 0.2
    max_long_side: int = 1920  # training resolution cap (was 1600; matches frames.MAX_LONG_SIDE)
    seed: int = 42
    log_every: int = 1000
    # Per-image affine colour correction (3x4), applied to renders during training only, so
    # exposure/white-balance differences between views (HDR tonemap vs phone stills) are
    # absorbed there instead of by view-dependent floaters. Off by default.
    appearance_affine: bool = False
    appearance_lr: float = 1e-3
    appearance_reg: float = 0.01
    # MCMC position noise multiplier (gsplat default 5e5). The noise scales with each Gaussian's
    # covariance, so big faint Gaussians on blank indoor walls take huge random steps and the
    # model breaks down once the cap is reached (giriskoridor, 2026-11-09). Lower it for such rooms.
    noise_lr: float = 5e5
    # Camera pose refinement: a learned per-image SE(3) correction (3 translation + 6D rotation,
    # zero = the solved pose), so small COLMAP/GLOMAP pose errors stop blurring fine detail.
    # gsplat simple_trainer's settings; Adam weight decay keeps corrections small. Off by default.
    # The refined poses are written back into scene.w2c (preview + final), so the depth renders
    # for collision.glb use the same cameras the splat was fitted to.
    pose_opt: bool = False
    pose_opt_lr: float = 1e-5
    pose_opt_reg: float = 1e-6


def rotation_6d_to_matrix(d6: torch.Tensor) -> torch.Tensor:
    """[..., 6] -> [..., 3, 3] (Zhou et al. 2019: Gram-Schmidt on two columns; rows here)."""
    import torch
    import torch.nn.functional as F

    a1, a2 = d6[..., :3], d6[..., 3:]
    b1 = F.normalize(a1, dim=-1)
    b2 = F.normalize(a2 - (b1 * a2).sum(-1, keepdim=True) * b1, dim=-1)
    b3 = torch.cross(b1, b2, dim=-1)
    return torch.stack((b1, b2, b3), dim=-2)


POSE_IDENTITY_6D = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)


def refine_viewmats(viewmats: torch.Tensor, delta: torch.Tensor) -> torch.Tensor:
    """World-to-camera [C, 4, 4] with per-camera deltas [C, 9] (dx, dy, dz, d6 - identity)
    applied in camera-to-world space: c2w' = c2w @ T(delta). delta = 0 returns viewmats."""
    import torch

    # Rigid transforms: invert as [R^T | -R^T t] (torch.linalg.inv on tiny GPU matrices costs
    # a cuSOLVER launch + sync per call and made training ~7x slower early on).
    R, t = viewmats[:, :3, :3], viewmats[:, :3, 3:]
    eye6 = torch.tensor(POSE_IDENTITY_6D, dtype=delta.dtype, device=delta.device)
    dR = rotation_6d_to_matrix(delta[:, 3:] + eye6)
    dt = delta[:, :3, None]
    # c2w' = c2w @ T: R_c2w' = R^T dR, t_c2w' = R^T (dt - t). w2c' = inverse of that.
    R_new = dR.transpose(1, 2) @ R
    t_new = -(dR.transpose(1, 2) @ (dt - t))
    out = torch.zeros_like(viewmats)
    out[:, :3, :3] = R_new
    out[:, :3, 3:] = t_new
    out[:, 3, 3] = 1.0
    return out


def pose_correction_stats(before: np.ndarray, after: np.ndarray) -> dict[str, float]:
    """How far refinement moved the cameras: centre shift (scene units) and rotation (deg)."""
    def centres(w2c: np.ndarray) -> np.ndarray:
        R, t = w2c[:, :3, :3], w2c[:, :3, 3]
        return -np.einsum("cji,cj->ci", R, t)

    shift = np.linalg.norm(centres(after) - centres(before), axis=1)
    rel = np.einsum("cij,ckj->cik", after[:, :3, :3], before[:, :3, :3])  # R_after @ R_before^T
    cos = np.clip((np.trace(rel, axis1=1, axis2=2) - 1) / 2, -1.0, 1.0)
    rot = np.degrees(np.arccos(cos))
    return {"pose_shift_median": float(np.median(shift)), "pose_shift_max": float(shift.max()),
            "pose_rot_median_deg": float(np.median(rot)), "pose_rot_max_deg": float(rot.max())}


def camera_extent(centres: np.ndarray) -> float:
    """gsplat's scene scale (1.1 x the camera spread), robust to a few stray cameras.

    It scales the means LR and MCMC's position noise; one mis-registered camera 30 m out made
    it 8x too big on job 9acd3d47 and the Gaussians random-walked out of the room.
    """
    c = np.asarray(centres, dtype=np.float64)
    d = np.linalg.norm(c - c.mean(axis=0), axis=1)
    return max(1.1 * min(float(d.max()), 2.0 * float(np.percentile(d, 90))), 1e-3)


def anisotropy_penalty(log_scales: torch.Tensor, max_ratio: float) -> torch.Tensor:
    """Mean hinge on log(longest / middle axis) above log(max_ratio). log_scales is [N, 3]."""
    import torch

    s = torch.sort(log_scales, dim=-1).values
    return torch.relu(s[:, 2] - s[:, 1] - math.log(max_ratio)).mean()


def _sh0_from_rgb(rgb01: torch.Tensor) -> torch.Tensor:
    C0 = 0.28209479177387814
    return (rgb01 - 0.5) / C0


def _knn_mean_dist(x: torch.Tensor, k: int = 3, chunk: int = 4096) -> torch.Tensor:
    import torch

    out = torch.empty(len(x), device=x.device)
    for i in range(0, len(x), chunk):
        d = torch.cdist(x[i:i + chunk], x)  # (c, N)
        vals, _ = d.topk(k + 1, dim=1, largest=False)  # includes self at 0
        out[i:i + chunk] = vals[:, 1:].pow(2).mean(dim=1).sqrt()
    return out


def _ssim(img1: torch.Tensor, img2: torch.Tensor) -> torch.Tensor:
    """SSIM with an 11x11 Gaussian window (sigma 1.5); inputs [B, 3, H, W] in [0, 1]."""
    import torch
    import torch.nn.functional as F

    g = torch.exp(-((torch.arange(11, device=img1.device) - 5.0) ** 2) / (2 * 1.5 ** 2))
    g = g / g.sum()
    w = (g[:, None] @ g[None, :]).expand(3, 1, 11, 11).contiguous()

    def f(t: torch.Tensor) -> torch.Tensor:
        return F.conv2d(t, w, padding=5, groups=3)

    mu1, mu2 = f(img1), f(img2)
    s11 = f(img1 * img1) - mu1 ** 2
    s22 = f(img2 * img2) - mu2 ** 2
    s12 = f(img1 * img2) - mu1 * mu2
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    m = ((2 * mu1 * mu2 + c1) * (2 * s12 + c2)) / ((mu1 ** 2 + mu2 ** 2 + c1) * (s11 + s22 + c2))
    return m.mean()


def load_images(scene: Scene, images_dir: Path, max_long_side: int) -> tuple[list[np.ndarray], np.ndarray]:
    """RGB uint8 images (resized to the cap) and matching intrinsics."""
    import cv2

    imgs, Ks = [], []
    for name, K, w, h in zip(scene.image_names, scene.K, scene.width, scene.height):
        img = cv2.imread(str(Path(images_dir) / name), cv2.IMREAD_COLOR)
        if img is None:
            raise FileNotFoundError(f"missing training image {name}")
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        assert img.shape[1] == w and img.shape[0] == h, f"{name}: image size != camera size"
        f = min(1.0, max_long_side / max(w, h))
        K = K.copy()
        if f < 1.0:
            nw, nh = round(w * f), round(h * f)
            img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
            K[0, :] *= nw / w
            K[1, :] *= nh / h
        imgs.append(img)
        Ks.append(K)
    return imgs, np.array(Ks)


def _to_splats(params: Any) -> Splats:
    import torch

    with torch.no_grad():
        return Splats(
            means=params["means"].detach().cpu().numpy(),
            scales=params["scales"].detach().cpu().numpy(),
            quats=params["quats"].detach().cpu().numpy(),
            opacities=params["opacities"].detach().cpu().numpy(),
            sh0=params["sh0"].detach().cpu().numpy()[:, 0, :],
            sh_rest=params["shN"].detach().cpu().numpy(),
        )


def train_gaussians(scene: Scene, images_dir: Path, cfg: TrainConfig, *,
                    snapshots: Sequence[int] = (),
                    on_snapshot: Callable[[int, Splats], None] | None = None,
                    on_log: Callable[[int, int], None] | None = None) -> tuple[Splats, dict[str, Any]]:
    """Train cfg.iters steps. After `n` steps for each n in snapshots (< cfg.iters), calls
    on_snapshot(n, splats) (the preview); on_log(steps_done, iters) every cfg.log_every steps."""
    import torch
    from gsplat import MCMCStrategy, rasterization

    torch.manual_seed(cfg.seed)
    dev = torch.device("cuda")
    t0 = time.perf_counter()
    imgs_np, Ks_np = load_images(scene, images_dir, cfg.max_long_side)
    images = [torch.from_numpy(im).to(dev) for im in imgs_np]  # uint8 HxWx3 on GPU
    Ks = torch.tensor(Ks_np, dtype=torch.float32, device=dev)
    viewmats = torch.tensor(scene.w2c, dtype=torch.float32, device=dev)
    load_s = time.perf_counter() - t0

    scene_scale = camera_extent(scene.camera_centres())

    pts = torch.tensor(scene.points, dtype=torch.float32, device=dev)
    rgb = torch.tensor(scene.colors, dtype=torch.float32, device=dev) / 255.0
    if len(pts) < 1000:
        raise RuntimeError(f"only {len(pts)} sparse points to initialise from (need 1000); "
                           "the camera solve found too little texture")
    n = len(pts)
    dist = _knn_mean_dist(pts).clamp_min(1e-7)
    K_sh = (cfg.sh_degree + 1) ** 2 - 1
    params = torch.nn.ParameterDict({
        "means": torch.nn.Parameter(pts),
        "scales": torch.nn.Parameter(torch.log(dist * cfg.init_scale)[:, None].repeat(1, 3)),
        "quats": torch.nn.Parameter(torch.rand(n, 4, device=dev)),
        "opacities": torch.nn.Parameter(torch.logit(torch.full((n,), cfg.init_opacity, device=dev))),
        "sh0": torch.nn.Parameter(_sh0_from_rgb(rgb)[:, None, :]),
        "shN": torch.nn.Parameter(torch.zeros(n, K_sh, 3, device=dev)),
    })
    lrs = {"means": 1.6e-4 * scene_scale, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2,
           "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    optimizers = {k: torch.optim.Adam([{"params": params[k], "lr": lr, "name": k}], eps=1e-15)
                  for k, lr in lrs.items()}
    means_sched = torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=0.01 ** (1.0 / cfg.iters))

    strategy = MCMCStrategy(
        cap_max=cfg.cap_max,
        noise_lr=cfg.noise_lr,
        refine_start_iter=500,
        refine_stop_iter=int(cfg.iters * 25 / 30),
        refine_every=100,
    )
    strategy.check_sanity(params, optimizers)
    state = strategy.initialize_state()

    app_aff = app_opt = None
    if cfg.appearance_affine:
        app_aff = torch.nn.Parameter(torch.eye(3, 4, device=dev).repeat(len(images), 1, 1))
        app_opt = torch.optim.Adam([app_aff], lr=cfg.appearance_lr, eps=1e-15)  # kept out of the strategy's dict
        eye34 = torch.eye(3, 4, device=dev)

    pose_delta = pose_opt = None
    if cfg.pose_opt:
        pose_delta = torch.nn.Parameter(torch.zeros(len(images), 9, device=dev))
        pose_opt = torch.optim.Adam([pose_delta], lr=cfg.pose_opt_lr, weight_decay=cfg.pose_opt_reg)

    def current_w2c() -> np.ndarray:
        with torch.no_grad():
            return refine_viewmats(viewmats, pose_delta).cpu().numpy().astype(scene.w2c.dtype)

    solved_w2c = scene.w2c.copy()

    rng = np.random.default_rng(cfg.seed)
    order: list[int] = []
    snaps = {int(n) for n in snapshots if 0 < int(n) < cfg.iters}
    snapshot_s = 0.0  # time spent in on_snapshot (depth render, collision, file writes)
    t_train = time.perf_counter()
    for step in range(cfg.iters):
        if not order:
            order = list(rng.permutation(len(images)))
        ci = order.pop()
        gt = images[ci].float()[None] / 255.0  # [1, H, W, 3]
        H, W = gt.shape[1:3]
        sh_deg = min(step // cfg.sh_degree_interval, cfg.sh_degree)
        colors = torch.cat([params["sh0"], params["shN"]], dim=1)
        vm = viewmats[ci:ci + 1]
        if pose_delta is not None:
            vm = refine_viewmats(vm, pose_delta[ci:ci + 1])
        renders, _alphas, info = rasterization(
            means=params["means"],
            quats=params["quats"],
            scales=torch.exp(params["scales"]),
            opacities=torch.sigmoid(params["opacities"]),
            colors=colors,
            viewmats=vm,
            Ks=Ks[ci:ci + 1],
            width=W,
            height=H,
            sh_degree=sh_deg,
            packed=False,
            near_plane=0.01,
            far_plane=1e10,
            render_mode="RGB",
        )
        pred = renders[..., :3]
        if app_aff is not None:
            A = app_aff[ci]
            pred = pred @ A[:, :3].T + A[:, 3]
        l1 = (pred - gt).abs().mean()
        ssim = _ssim(pred.permute(0, 3, 1, 2), gt.permute(0, 3, 1, 2))
        loss = (1 - cfg.ssim_lambda) * l1 + cfg.ssim_lambda * (1 - ssim)
        loss = loss + cfg.opacity_reg * torch.sigmoid(params["opacities"]).abs().mean()
        loss = loss + cfg.scale_reg * torch.exp(params["scales"]).abs().mean()
        if cfg.aniso_reg > 0:
            loss = loss + cfg.aniso_reg * anisotropy_penalty(params["scales"], cfg.max_aniso)
        if app_aff is not None:
            loss = loss + cfg.appearance_reg * (app_aff[ci] - eye34).pow(2).mean()
        loss.backward()
        for opt in optimizers.values():
            opt.step()
            opt.zero_grad(set_to_none=True)
        if app_opt is not None:
            app_opt.step()
            app_opt.zero_grad(set_to_none=True)
        if pose_opt is not None:
            pose_opt.step()
            pose_opt.zero_grad(set_to_none=True)
        means_sched.step()
        strategy.step_post_backward(params, optimizers, state, step, info, lr=means_sched.get_last_lr()[0])
        if step % cfg.log_every == 0 or step == cfg.iters - 1:
            el = time.perf_counter() - t_train - snapshot_s
            print(f"[train] step {step}/{cfg.iters} loss {loss.item():.4f} l1 {l1.item():.4f} "
                  f"gaussians {len(params['means'])} {el:.0f}s", flush=True)
            if on_log is not None:
                on_log(step + 1, cfg.iters)
        if on_snapshot is not None and step + 1 in snaps:
            ts = time.perf_counter()
            if pose_delta is not None:
                scene.w2c[:] = current_w2c()  # preview's collision uses the refined cameras
            on_snapshot(step + 1, _to_splats(params))
            snapshot_s += time.perf_counter() - ts
    torch.cuda.synchronize()
    train_s = time.perf_counter() - t_train - snapshot_s

    out = _to_splats(params)
    stats = {"load_s": load_s, "train_s": train_s, "snapshot_s": snapshot_s, "final_loss": float(loss.item()),
             "gaussians": out.count, "iters": cfg.iters, "s_per_1k_iters": 1000 * train_s / max(1, cfg.iters)}
    if pose_delta is not None:
        scene.w2c[:] = current_w2c()
        stats.update(pose_correction_stats(solved_w2c, scene.w2c))
        print(f"[train] pose refinement: {stats}", flush=True)
    return out, stats


def render_depths(splats: Splats, scene: Scene, max_long_side: int = 800,
                  min_alpha: float = 0.5) -> tuple[list[np.ndarray], np.ndarray]:
    """Expected depth (metres) per training view, 0 where alpha < min_alpha. GPU."""
    import torch
    from gsplat import rasterization

    dev = torch.device("cuda")
    means = torch.tensor(splats.means, device=dev)
    quats = torch.tensor(splats.quats, device=dev)
    scales = torch.exp(torch.tensor(splats.scales, device=dev))
    opac = torch.sigmoid(torch.tensor(splats.opacities, device=dev))
    colors = torch.cat([torch.tensor(splats.sh0, device=dev)[:, None, :],
                        torch.tensor(splats.sh_rest, device=dev)], dim=1)
    sh_deg = int(round(math.sqrt(colors.shape[1]))) - 1
    depths, Ks_out = [], []
    with torch.no_grad():
        for K, w, h, M in zip(scene.K, scene.width, scene.height, scene.w2c):
            f = min(1.0, max_long_side / max(int(w), int(h)))
            W, H = round(int(w) * f), round(int(h) * f)
            K2 = K.copy()
            K2[0, :] *= W / int(w)
            K2[1, :] *= H / int(h)
            renders, alphas, _ = rasterization(
                means=means, quats=quats, scales=scales, opacities=opac, colors=colors,
                viewmats=torch.tensor(M, dtype=torch.float32, device=dev)[None],
                Ks=torch.tensor(K2, dtype=torch.float32, device=dev)[None],
                width=W, height=H, sh_degree=sh_deg, packed=False, render_mode="RGB+ED",
            )
            d = renders[0, ..., 3]
            d = torch.where(alphas[0, ..., 0] >= min_alpha, d, torch.zeros_like(d))
            depths.append(d.float().cpu().numpy())
            Ks_out.append(K2)
    return depths, np.array(Ks_out)
