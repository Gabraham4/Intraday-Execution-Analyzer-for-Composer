#!/bin/bash
# Double-click this file to launch the Intraday Execution Analyzer Web GUI

cd "$(dirname "$0")/app"

PORT=3000

echo ""
echo "  Starting Intraday Execution Analyzer GUI..."
echo "  Opening http://localhost:$PORT in your browser..."
echo ""

(sleep 2 && open "http://localhost:$PORT") &

node gui-server.js
