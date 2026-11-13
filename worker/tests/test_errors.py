import pickle

from pipeline.errors import PipelineError


def test_pipeline_error_survives_pickling():
    e = pickle.loads(pickle.dumps(PipelineError("Too blurry.", stage="frames", detail="median 12")))
    assert isinstance(e, PipelineError)
    assert (e.user_message, e.stage, e.detail) == ("Too blurry.", "frames", "median 12")


def test_retry_on_new_host_survives_pickling():
    e = pickle.loads(pickle.dumps(PipelineError("x", stage="solve", retry_on_new_host=True)))
    assert e.retry_on_new_host is True
