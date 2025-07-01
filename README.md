# PDF Agent MCP

A Model Context Protocol server designed for agentic reading and selective PDF processing. Enables AI systems to efficiently navigate and extract content from PDFs without overwhelming context windows.

## Features

- **Metadata Extraction**: Get PDF properties, page count, and file information
- **Text Extraction**: Native text extraction with hybrid processing for better results
- **Image Conversion**: Convert PDF pages to optimized images for visual analysis
- **Content Search**: Pattern/regex search with context snippets
- **Table of Contents**: Extract bookmarks and document outline
- **Flexible Path Support**: Use absolute paths or relative paths from `~/pdf-agent/`

## Usage Guide

PDF Agent MCP solves the common problem of context window overflow when working with PDFs in AI tools. 

**Important: Do not drag PDFs into the chat** - this will load the entire PDF content traditionally and bypass the intelligent processing. Instead, provide file paths or URLs to activate the PDF Agent tools for selective processing.

### How to Use

**For Local PDFs:**
- Provide the absolute file path to your PDF
- Quick tip: Right-click your PDF → "Open with Chrome" → copy the address bar URL for the absolute path

**For Online PDFs:**
- Simply provide the PDF URL - the agent will download and process it locally

### Key Benefits

- **Selective Reading**: The AI first examines metadata and outline, then opens only relevant pages
- **Token Efficiency**: Avoids images when possible, uses them only when necessary for visual analysis
- **Scalable**: Works with large documents (1000+ page textbooks) and multiple PDFs simultaneously
- **Search Capability**: Built-in pattern/regex search across PDF content

### Approach

This MCP uses **agentic search with simple tools** rather than complex alternatives:
- No embedding creation, chunking, or vector storage required
- No multi-agent coordination or handoff complexity
- Just clean, effective tools that modern AI systems can use intelligently

Perfect for researchers, students, and professionals working with extensive PDF libraries.

## Requirements

**Node.js**: This extension requires **Node.js LTS** (Long Term Support version).

- **Install Node.js LTS**: Visit [nodejs.org](https://nodejs.org/) and download the LTS version
- **Alternative**: Use a Node.js version manager like [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm)

## Installation

### Option 1: DXT Package (Recommended)

1. Download the latest `pdf-agent-mcp.dxt` file from the releases
2. Double-click the `.dxt` file to install it in Claude Desktop

This will create a configuration file at:

### Option 2: Manual Installation

1. Clone this repository
2. Build the project: `npm install && npm run build`
3. Find your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the following:

```json
{
  "mcpServers": {
    "pdf-agent": {
      "command": "node",
      "args": [
        "PATH_TO_REPO/server/index.js"
      ]
    }
  }
}
```

Replace `PATH_TO_REPO` with the actual path to your cloned repository.

## Troubleshooting

If you experience issues loading the extension in Claude Desktop:

1. Go to **Claude > Settings > Extensions > Advanced Settings**
2. **Disable** "Use Built-in Node.js for MCP"
3. Restart Claude Desktop

This ensures the extension uses your system's Node.js installation instead of Claude's built-in version.

## Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Create DXT package
npm run build:dxt

# Pack the final .dxt file for distribution
dxt pack
```

### Viewing Logs

To debug issues, you can view the MCP server logs:

```bash
# View logs (macOS)
open "$HOME/Library/Logs/Claude/mcp-server-PDF Agent MCP.log"

# Stream logs in real-time (macOS)
tail -f "$HOME/Library/Logs/Claude/mcp-server-PDF Agent MCP.log"

# Clear/delete logs (macOS)
rm "$HOME/Library/Logs/Claude/mcp-server-PDF Agent MCP.log"

# View logs (Windows)
notepad "%LOCALAPPDATA%\Claude\Logs\mcp-server-PDF Agent MCP.log"

# Clear/delete logs (Windows)
del "%LOCALAPPDATA%\Claude\Logs\mcp-server-PDF Agent MCP.log"
```

## License

MIT