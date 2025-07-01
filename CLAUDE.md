# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PDF Agent MCP is a Model Context Protocol server designed for agentic reading and selective PDF processing. It enables AI systems to efficiently navigate and extract content from PDFs without overwhelming context windows, preventing failures, slowness, and high costs associated with processing entire documents.

## Core Architecture

The project is structured as a TypeScript-based MCP server with five main tools:

- **get_pdf_metadata**: Extract PDF metadata, page count, file size, and document properties
- **get_pdf_text**: Hybrid text extraction (native PDF.js + OCR fallback via Tesseract.js)
- **get_pdf_images**: Convert PDF pages to base64-encoded images with optimization
- **search_pdf**: Pattern/regex search with context snippets and early stopping
- **get_pdf_outline**: Extract table of contents/bookmarks with hierarchical navigation

### Key Components

- **Path Resolution**: Dual path system supporting both absolute paths and relative paths from `~/pdf-agent/` directory
- **Text Extraction Strategies**: Three modes - `hybrid` (default), `native` (PDF.js only), `ocr` (Tesseract only)
- **Page Range Parsing**: Python-style slicing (`"5"`, `"5:10"`, `"7:"`, `":5"`)
- **Error Handling**: Comprehensive validation with Zod schemas and timeout protection
- **Image Processing**: Sharp-based optimization with format/quality/dimension controls

### PDF Processing Libraries

- **pdf-lib**: Metadata extraction and page counting
- **pdfjs-dist**: Native text extraction and outline parsing
- **tesseract.js**: OCR for scanned/image-based PDFs
- **pdf-to-png-converter**: PDF to image conversion
- **sharp**: Image optimization and format conversion

## Development Commands

```bash
# Build TypeScript to JavaScript
npm run build

# Development build and run
npm run dev

# Create DXT package for distribution
npm run build:dxt

# Clean build artifacts
npm run clean

# Start the MCP server
npm start
```

## Testing

Manual testing can be done by running the MCP server and using the tools directly through the Claude Desktop interface.

## DXT Packaging

The project packages as a Desktop Extension (DXT) with:
- **manifest.json**: DXT configuration with tool descriptions
- **icon.png**: Custom PDF-themed icon
- **server/index.js**: Compiled MCP server entry point
- **pdf-agent-mcp.dxt**: Final distributable package

Use `dxt pack` after `npm run build:dxt` to generate the .dxt file.

## File Structure

```
src/index.ts           # Main MCP server implementation
manifest.json          # DXT packaging manifest
package.json           # NPM configuration with DXT build scripts
tsconfig.json          # TypeScript configuration
server/               # Compiled server files
dist/                 # NPM package artifacts
```

## Configuration Constants

- **MAX_FILE_SIZE**: 100MB PDF size limit
- **OPERATION_TIMEOUT**: 30 second timeout for operations
- **Default PDF Home**: `~/pdf-agent/` directory for relative paths

## Error Handling Patterns

All tools follow consistent error patterns:
- Zod schema validation for inputs
- File existence verification
- Path resolution (absolute vs relative)
- Size and timeout limits
- Graceful fallbacks (hybrid text extraction)
- Structured JSON error responses

## Feature Implementation Process

When implementing new features: read plan.md, pick the next high-level feature, create an implementation plan, highlight questions/issues, and agree on the approach before coding.

## Project Reference

Use `/Users/vladgheorghe/mcp/dna-analysis-mcp` as reference for MCP server patterns, language choices, framework usage, and project structure conventions.

## Release Process

### Version Management
- **CRITICAL**: Always ensure `manifest.json` version matches the GitHub release version
- Check `manifest.json` version field before creating any release
- Update version in `manifest.json` if needed before release

### Release Steps
1. **Build and Package**:
   ```bash
   npm run build:dxt
   dxt pack
   ```

2. **Commit and Push Changes**:
   ```bash
   git add .
   git commit -m "Release preparation for vX.X.X"
   git push origin main
   ```

3. **Create GitHub Release**:
   ```bash
   gh release create vX.X.X --title "PDF Agent MCP vX.X.X" --notes "Release notes..." 
   ```

4. **Upload DXT File to Release Assets**:
   ```bash
   gh release upload vX.X.X pdf-agent-mcp.dxt
   ```

### Important Notes
- **NEVER** forget to upload the DXT file to release assets - users need this file to install the extension
- The DXT file must be available in the GitHub release assets, not just mentioned in the release notes
- Always verify the release has the DXT file attached before considering it complete

## Development Workflow Memories

- If you made changes and you expect me to test them, you need to rebuild the project, especially running dxt pack
- Always check manifest.json version matches release version before creating releases
- DXT file MUST be uploaded to GitHub release assets