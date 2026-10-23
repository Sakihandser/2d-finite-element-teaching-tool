"""Scoped Windows idle-sleep prevention; explicit sleep and lid policies still apply."""
from contextlib import contextmanager
import os


@contextmanager
def keep_awake(enabled,on_status):
    setter=None
    if enabled and os.name=='nt':
        try:
            import ctypes
            setter=ctypes.windll.kernel32.SetThreadExecutionState
            setter.argtypes=[ctypes.c_uint];setter.restype=ctypes.c_uint
            if not setter(0x80000001):setter=None
        except (AttributeError,OSError):setter=None
    on_status(bool(setter))
    try:yield
    finally:
        if setter:setter(0x80000000)
        on_status(False)
