"""python -m codeflow_py [root]  -> prints the graph JSON (debug helper); no args -> JSON-RPC server."""
import json
import sys

from . import server

if len(sys.argv) > 1:
    from .analyze import Analyzer
    print(json.dumps(Analyzer(sys.argv[1], ["**/.venv/**", "**/__pycache__/**", "/tests/**"]).analyze(), indent=1))
else:
    server.serve()
