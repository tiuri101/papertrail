class TransientJobError(RuntimeError):
    """A temporary failure that can use the normal retry policy."""
