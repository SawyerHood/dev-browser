#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Change to the script directory
cd "$SCRIPT_DIR"

# Parse command line arguments
HEADLESS=false
FORCE_STANDALONE=false
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --headless) HEADLESS=true ;;
        --standalone) FORCE_STANDALONE=true ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

# Conditional npm install - only if node_modules missing or package-lock changed
NEEDS_INSTALL=false
HASH_FILE="$SCRIPT_DIR/.npm-install-hash"

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    NEEDS_INSTALL=true
elif [ -f "$SCRIPT_DIR/package-lock.json" ]; then
    CURRENT_HASH=$(shasum "$SCRIPT_DIR/package-lock.json" 2>/dev/null | cut -d' ' -f1)
    SAVED_HASH=$(cat "$HASH_FILE" 2>/dev/null || echo "")
    if [ "$CURRENT_HASH" != "$SAVED_HASH" ]; then
        NEEDS_INSTALL=true
    fi
fi

if [ "$NEEDS_INSTALL" = true ]; then
    echo "Installing dependencies..."
    npm install --prefer-offline --no-audit --no-fund
    # Save hash for next time
    if [ -f "$SCRIPT_DIR/package-lock.json" ]; then
        shasum "$SCRIPT_DIR/package-lock.json" | cut -d' ' -f1 > "$HASH_FILE"
    fi
else
    echo "Dependencies up to date (skipping npm install)"
fi

# Build if dist doesn't exist (first run optimization)
if [ ! -f "$SCRIPT_DIR/dist/start-server.js" ]; then
    echo "Building TypeScript (first run)..."
    npm run build
fi

# Get browser configuration from config file
# Config is at ~/.dev-browser/config.json
if [ "$FORCE_STANDALONE" = true ]; then
    BROWSER_MODE="standalone"
    BROWSER_PATH=""
else
    # Read config using TypeScript helper
    CONFIG_OUTPUT=$(npx tsx scripts/get-browser-config.ts 2>&1)
    CONFIG_EXIT=$?
    if [ $CONFIG_EXIT -eq 0 ]; then
        eval "$CONFIG_OUTPUT"
    else
        # Config read failed - show error and exit (don't fall back to standalone)
        echo "Error: Failed to read browser configuration"
        echo "$CONFIG_OUTPUT"
        echo ""
        echo "Set browser.path in ~/.dev-browser/config.json to your Chrome executable or app bundle."
        exit 1
    fi
fi

# Start the appropriate server mode
if [ "$BROWSER_MODE" = "external" ] && [ -n "$BROWSER_PATH" ]; then
    echo "Starting dev-browser server (External Browser mode)..."
    echo "  Browser: $BROWSER_PATH"
    echo "  Config: ~/.dev-browser/config.json"
    echo "  Use --standalone flag to force standalone Playwright mode"
    echo ""

    export BROWSER_PATH
    # Only export USER_DATA_DIR if explicitly configured (not empty)
    if [ -n "$BROWSER_USER_DATA_DIR" ]; then
        export USER_DATA_DIR="$BROWSER_USER_DATA_DIR"
    fi
    # Export extra args if configured (JSON array string)
    if [ -n "$BROWSER_EXTRA_ARGS" ] && [ "$BROWSER_EXTRA_ARGS" != "[]" ]; then
        export EXTRA_ARGS="$BROWSER_EXTRA_ARGS"
    fi
    npx tsx scripts/start-external-browser.ts
else
    # Only reach here if --standalone was explicitly passed
    if [ "$FORCE_STANDALONE" = true ]; then
        echo "Starting dev-browser server (Standalone mode - forced)..."
        echo "  WARNING: Using Playwright's bundled Chromium, not Chrome for Testing"
        echo "  For consistent behavior, use Chrome for Testing instead"
        echo ""

        export HEADLESS=$HEADLESS
        # Use pre-compiled JS for faster startup (~700ms savings)
        if [ -f "$SCRIPT_DIR/dist/start-server.js" ]; then
            node "$SCRIPT_DIR/dist/start-server.js"
        else
            # Fallback to tsx if build failed
            npx tsx scripts/start-server.ts
        fi
    else
        # Should not reach here - config should have failed earlier
        echo "Error: No browser configured and standalone mode not forced"
        echo ""
        echo "Set browser.path in ~/.dev-browser/config.json to your Chrome executable or app bundle."
        exit 1
    fi
fi
