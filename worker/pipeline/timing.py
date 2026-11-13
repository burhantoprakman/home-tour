"""Per-stage wall time and GPU seconds, printed to stdout (the jobs table comes in Step 2)."""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field


@dataclass
class StageTimes:
    wall_s: dict[str, float] = field(default_factory=dict)
    gpu_s: dict[str, float] = field(default_factory=dict)

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        print(f"[stage] {name} ...", flush=True)
        t0 = time.perf_counter()
        try:
            yield
        finally:
            dt = time.perf_counter() - t0
            self.wall_s[name] = self.wall_s.get(name, 0.0) + dt
            print(f"[stage] {name} done in {dt:.1f}s", flush=True)

    def add_gpu(self, name: str, seconds: float) -> None:
        self.gpu_s[name] = self.gpu_s.get(name, 0.0) + seconds

    @property
    def total_gpu_s(self) -> float:
        return sum(self.gpu_s.values())

    def summary(self) -> str:
        lines = ["stage timings:"]
        for name, s in self.wall_s.items():
            gpu = self.gpu_s.get(name)
            extra = f"  (gpu {gpu:.1f}s)" if gpu is not None else ""
            lines.append(f"  {name:<10} {s:8.1f}s{extra}")
        for name, s in self.gpu_s.items():
            if name not in self.wall_s:
                lines.append(f"  {name:<10} gpu {s:8.1f}s")
        lines.append(f"  total wall {sum(self.wall_s.values()):.1f}s, total gpu {self.total_gpu_s:.1f}s")
        return "\n".join(lines)
