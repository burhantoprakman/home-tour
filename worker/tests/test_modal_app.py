import importlib


def test_app_imports_without_gpu_or_auth():
    app_mod = importlib.import_module("app")
    assert app_mod.app.name == "home-tour-worker"
    assert app_mod.GPUS[0] == "L40S"
    import modal

    for name in ("train_room", "prepare_room", "process_room"):
        fn = getattr(app_mod, name)
        assert isinstance(fn, modal.Function), name
        assert hasattr(fn, "remote") and hasattr(fn, "spawn")


def test_secret_list_is_the_same_locally_and_in_the_container(monkeypatch):
    """The container re-imports app.py; a different dependency list crash-loops the deployment."""
    import modal

    app_mod = importlib.import_module("app")
    local = app_mod._secrets()
    monkeypatch.setattr(modal, "is_local", lambda: False)
    assert len(app_mod._secrets()) == len(local) == 1


def test_gpu_modules_import_without_torch():
    importlib.import_module("pipeline.train")
    importlib.import_module("pipeline.job")
