#!/bin/bash
# Double-click this file to launch the Intraday Execution Analyzer Web GUI

cd "$(dirname "$0")/app"

PORT=3000

# Kill the server when the terminal window is closed (SIGHUP), Ctrl+C (SIGINT), or terminated (SIGTERM)
cleanup() {
  echo ""
  echo "  Shutting down Intraday Analyzer..."
  kill $SERVER_PID 2>/dev/null
  wait $SERVER_PID 2>/dev/null
  exit 0
}
trap cleanup SIGHUP SIGINT SIGTERM

echo ""
echo "  Starting Intraday Execution Analyzer GUI..."
echo "  Opening http://localhost:$PORT in your browser..."
echo ""

(sleep 2 && open "http://localhost:$PORT") &

node gui-server.js &
SERVER_PID=$!
wait $SERVER_PID
