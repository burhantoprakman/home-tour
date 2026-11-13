"""User-readable pipeline failures. The message is what the owner sees on the job."""


class PipelineError(Exception):
    """A failure we can explain to the homeowner (bad capture, missing floor, ...)."""

    def __init__(self, user_message: str, *, stage: str, detail: str | None = None,
                 retry_on_new_host: bool = False) -> None:
        super().__init__(user_message)
        self.user_message = user_message
        self.stage = stage
        self.detail = detail
        # The cloud machine, not the video, was at fault (e.g. a tool hit an illegal CPU
        # instruction): the same step may succeed on another machine.
        self.retry_on_new_host = retry_on_new_host

    def __reduce__(self):  # keep all fields across pickling (Modal re-raises remote errors)
        return (_rebuild, (self.user_message, self.stage, self.detail, self.retry_on_new_host))

    def __str__(self) -> str:
        if self.detail:
            return f"[{self.stage}] {self.user_message} ({self.detail})"
        return f"[{self.stage}] {self.user_message}"


def _rebuild(user_message: str, stage: str, detail: str | None,
             retry_on_new_host: bool = False) -> PipelineError:
    return PipelineError(user_message, stage=stage, detail=detail, retry_on_new_host=retry_on_new_host)
