"""Code Flow Canvas Python sidecar: analyser + tracer."""
import os
import sys

_VENDOR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.append(_VENDOR)  # appended: a project's own jedi/parso wins if present
