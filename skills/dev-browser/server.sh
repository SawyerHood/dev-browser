#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Change to the script directory
cd "$SCRIPT_DIR"

# Parse command line arguments
HEADLESS=false
PORT=9222
CDP_PORT=""

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --headless) HEADLESS=true ;;
        --port) PORT="$2"; shift ;;
        --cdp-port) CDP_PORT="$2"; shift ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

echo "Installing dependencies..."
npm install

echo "Starting dev-browser server on port $PORT..."
export HEADLESS=$HEADLESS
export PORT=$PORT
export CDP_PORT=$CDP_PORT
npx tsx scripts/start-server.ts
