# PDF Agent MCP

## ⚠️ Important Setup Instructions

**Before using this extension, you MUST configure Claude Desktop properly:**

### Required Configuration

1. **Install Node.js LTS**: Visit [nodejs.org](https://nodejs.org/) and download the LTS version
2. **Configure Claude Desktop**:
   - Go to **Claude > Settings > Extensions > Advanced Settings**
   - **Disable** "Use Built-in Node.js for MCP"
   - Restart Claude Desktop

**This extension will NOT work with Claude's built-in Node.js**. You must use your system's Node.js installation.

### Troubleshooting

If you experience issues loading the extension:

1. Verify Node.js is installed: Run `node --version` in your terminal
2. Ensure "Use Built-in Node.js for MCP" is disabled in Claude Desktop settings
3. Restart Claude Desktop completely
4. Check the logs at `~/Library/Logs/Claude/mcp-server-PDF Agent MCP.log` (macOS) or `%LOCALAPPDATA%\Claude\Logs\mcp-server-PDF Agent MCP.log` (Windows)

---

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

## AI Assistant Prompt for Optimal Usage

**Copy this prompt into your AI assistant's custom instructions or context for best results:**

```
When working with PDFs using the PDF Agent MCP tools, follow this strategic approach:

### 1. Query Analysis & PDF Identification
- **Think carefully** about the user's search query and information needs
- **Identify which PDF(s)** are most likely to contain the answer
- Consider the document type, domain, and likely structure based on the query

### 2. Exploratory Phase (Always Start Here)
- **Get metadata** first using `get_pdf_metadata` to understand document size, creation date, and properties
- **Extract table of contents** with `get_pdf_outline` to understand document structure and navigation
- **Analyze the outline** to identify which sections are most relevant to the query

### 3. Strategic Content Extraction
Based on the outline and metadata:
- **Use page ranges** (`"5:10"`, `"20:"`) to focus on specific sections rather than entire documents
- **Extract images** with `get_pdf_images` when visual content is critical (charts, diagrams, tables, equations)
- **Choose text extraction strategy**: `hybrid` (default) for most cases, `native` for clean PDFs, `ocr` for scanned documents

### 4. Advanced Search Strategies
- **Use multiple search queries** with different keywords and synonyms
- **Apply regex patterns** for flexible matching: `/budget|cost|expense/gi` instead of single terms
- **Combine searches**: Start broad, then narrow down with specific terms
- **Use context characters** (150+ chars) to understand search result context
- **Implement early stopping** with `max_results` for large documents

### 5. Iterative Refinement
- **Start with targeted searches** based on outline analysis
- **Follow up with broader searches** if initial queries don't yield results
- **Extract specific page ranges** identified through search results
- **Use visual analysis** (images) when text extraction seems incomplete or when layout matters

### 6. Performance Optimization
- **Avoid processing entire large PDFs** - always use page ranges when possible
- **Use search with early stopping** before extracting large sections
- **Prefer search over full text extraction** for finding specific information
- **Extract images selectively** only when visual analysis is needed

### 7. Multi-Document Workflows
- **Process documents in parallel** when comparing multiple PDFs
- **Use consistent search terms** across documents for comparison
- **Combine results strategically** rather than processing everything at once

### Key Principles:
- **Strategic before comprehensive**: Understand document structure before diving deep
- **Search before extract**: Use pattern matching to locate relevant content first  
- **Visual when necessary**: Extract images only when text extraction is insufficient
- **Iterative refinement**: Start targeted, expand scope as needed
- **Context preservation**: Always maintain enough context around search results

This approach maximizes efficiency, minimizes token usage, and provides more accurate, focused results than traditional "dump entire PDF" methods.
```

## Installation

### Option 1: DXT Package (Recommended)

1. **First**, ensure you have completed the [Required Configuration](#required-configuration) above
2. Download the latest `pdf-agent-mcp.dxt` file from the releases
3. Double-click the `.dxt` file to install it in Claude Desktop

### Option 2: Manual Installation

1. **First**, ensure you have completed the [Required Configuration](#required-configuration) above
2. Clone this repository
3. Build the project: `npm install && npm run build`
4. Find your Claude Desktop config file:

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