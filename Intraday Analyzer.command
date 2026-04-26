#!/bin/bash
# Double-click this file to launch the Intraday Execution Analyzer Web GUI

cd "$(dirname "$0")/app"

PORT=3100

# Check if port is already in use
if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  BLOCKING_APP=$(lsof -i :"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 | xargs ps -p 2>/dev/null | tail -1 | awk '{print $4}')
  echo ""
  echo "  ERROR: Port $PORT is already in use (by $BLOCKING_APP)."
  echo "  Either close the app using that port, or run with a different port:"
  echo "    node gui-server.js --port=3101"
  echo ""
  exit 1
fi

# Kill the server AND its child processes when the terminal is closed
cleanup() {
  echo ""
  echo "  Shutting down Intraday Analyzer..."
  kill $SERVER_PID 2>/dev/null
  # Also kill any child processes (e.g. spawned node workers)
  pkill -P $SERVER_PID 2>/dev/null
  wait $SERVER_PID 2>/dev/null
  echo "  Port $PORT released. Goodbye!"
  exit 0
}
trap cleanup SIGHUP SIGINT SIGTERM EXIT

echo ""
echo "  Starting Intraday Execution Analyzer GUI..."
echo "  Opening http://localhost:$PORT in your browser..."
echo ""

(sleep 2 && open "http://localhost:$PORT") &

node gui-server.js --port=$PORT &
SERVER_PID=$!
wait $SERVER_PID
