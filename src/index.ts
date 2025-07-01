#!/usr/bin/env node

/**
 * PDF Agent MCP Server
 *
 * A Model Context Protocol server for dynamic PDF content extraction and analysis.
 * Provides tools for selective PDF content extraction, metadata analysis, and document processing.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, stat, mkdir, writeFile } from "fs/promises";
import { resolve, join, isAbsolute, extname, basename } from "path";
import { homedir } from "os";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfToPng } from "pdf-to-png-converter";
import sharp from "sharp";

// Configure PDF.js worker to use built-in worker
// Console suppression in extractTextNative prevents worker warnings from reaching stdout
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/build/pdf.worker.mjs';

// Override console methods during PDF operations to prevent stdout contamination
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info
};

function suppressConsoleOutput() {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.info = () => {};
}

function restoreConsoleOutput() {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.info = originalConsole.info;
}

// Enhanced logging for MCP environment - write to stderr to avoid corrupting JSON-RPC stdout
function log(level: 'info' | 'error' | 'warn', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] PDF-Agent-MCP: ${message}`;
  
  if (data) {
    process.stderr.write(`${logMessage} ${JSON.stringify(data)}\n`);
  } else {
    process.stderr.write(`${logMessage}\n`);
  }
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the PDF agent home directory path
 */
function getPdfAgentHome(): string {
  return join(homedir(), 'pdf-agent');
}

/**
 * Ensure the PDF agent home directory exists
 */
async function ensurePdfAgentHome(): Promise<string> {
  const pdfAgentHome = getPdfAgentHome();
  try {
    await mkdir(pdfAgentHome, { recursive: true });
  } catch (error) {
    // Directory might already exist, which is fine
    if (error instanceof Error && (error as any).code !== 'EEXIST') {
      throw new Error(`Failed to create PDF agent home directory at ${pdfAgentHome}: ${error.message}`);
    }
  }
  return pdfAgentHome;
}

// Define Zod schemas for tool inputs
const GetPdfMetadataSchema = z.object({
  absolute_path: z.string().optional(),
  relative_path: z.string().optional(),
  use_pdf_home: z.boolean().default(true),
}).refine(
  (data) => (data.absolute_path && !data.relative_path) || (!data.absolute_path && data.relative_path),
  {
    message: "Exactly one of 'absolute_path' or 'relative_path' must be provided",
  }
);

const GetPdfTextSchema = z.object({
  absolute_path: z.string().optional(),
  relative_path: z.string().optional(),
  use_pdf_home: z.boolean().default(true),
  page_range: z.string().default("1:"),
  extraction_strategy: z.enum(["hybrid", "native"]).default("hybrid"),
  preserve_formatting: z.boolean().default(true),
  line_breaks: z.boolean().default(true),
}).refine(
  (data) => (data.absolute_path && !data.relative_path) || (!data.absolute_path && data.relative_path),
  {
    message: "Exactly one of 'absolute_path' or 'relative_path' must be provided",
  }
);

const GetPdfImagesSchema = z.object({
  absolute_path: z.string().optional(),
  relative_path: z.string().optional(),
  use_pdf_home: z.boolean().default(true),
  page_range: z.string().default("1:"),
  format: z.enum(["png", "jpeg"]).default("jpeg"),
  quality: z.number().min(1).max(100).default(85),
  max_width: z.number().min(100).max(3000).optional(),
  max_height: z.number().min(100).max(3000).optional(),
}).refine(
  (data) => (data.absolute_path && !data.relative_path) || (!data.absolute_path && data.relative_path),
  {
    message: "Exactly one of 'absolute_path' or 'relative_path' must be provided",
  }
);

const SearchPdfSchema = z.object({
  absolute_path: z.string().optional(),
  relative_path: z.string().optional(),
  use_pdf_home: z.boolean().default(true),
  page_range: z.string().default("1:"),
  search_pattern: z.string().min(1),
  max_results: z.number().min(1).optional(),
  max_pages_scanned: z.number().min(1).optional(),
  context_chars: z.number().min(10).max(1000).default(150),
  search_timeout: z.number().min(1000).max(60000).default(10000),
}).refine(
  (data) => (data.absolute_path && !data.relative_path) || (!data.absolute_path && data.relative_path),
  {
    message: "Exactly one of 'absolute_path' or 'relative_path' must be provided",
  }
);

const GetPdfOutlineSchema = z.object({
  absolute_path: z.string().optional(),
  relative_path: z.string().optional(),
  use_pdf_home: z.boolean().default(true),
  include_destinations: z.boolean().default(true),
  max_depth: z.number().min(1).max(10).optional(),
  flatten_structure: z.boolean().default(false),
}).refine(
  (data) => (data.absolute_path && !data.relative_path) || (!data.absolute_path && data.relative_path),
  {
    message: "Exactly one of 'absolute_path' or 'relative_path' must be provided",
  }
);

const DownloadPdfSchema = z.object({
  url: z.string().url(),
  subfolder: z.string().default("downloads"),
  filename: z.string().optional(),
});

// Configuration constants
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB limit for PDF files
const OPERATION_TIMEOUT = 30000; // 30 second timeout for operations

/**
 * Parse page range string into array of page numbers (1-indexed)
 * Supports formats:
 * - Single pages: "5" → [5]
 * - Ranges: "5:10" → [5,6,7,8,9,10] 
 * - Open ranges: "7:" (from 7 to end), ":5" (from start to 5)
 * - Comma-separated combinations: "1,3:5,7,10:" → [1,3,4,5,7,10,11,...]
 * - Complex mixed: "1-3,7,8:10" → [1,2,3,7,8,9,10]
 */
function parsePageRange(rangeStr: string, totalPages: number): number[] {
  const range = rangeStr.trim();
  
  if (!range) {
    throw new Error("Page range cannot be empty");
  }
  
  // Split by commas to handle multiple segments
  const segments = range.split(',').map(seg => seg.trim()).filter(seg => seg.length > 0);
  
  if (segments.length === 0) {
    throw new Error("Page range cannot be empty after parsing");
  }
  
  const allPages = new Set<number>();
  
  // Process each segment
  for (const segment of segments) {
    try {
      const segmentPages = parseSinglePageRange(segment, totalPages);
      for (const page of segmentPages) {
        allPages.add(page);
      }
    } catch (error) {
      throw new Error(`Invalid segment '${segment}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  // Convert to sorted array
  return Array.from(allPages).sort((a, b) => a - b);
}

/**
 * Parse a single page range segment (no commas)
 * Supports: "5", "5:10", "7:", ":5"
 */
function parseSinglePageRange(segment: string, totalPages: number): number[] {
  const trimmed = segment.trim();
  
  if (!trimmed) {
    throw new Error("Page range segment cannot be empty");
  }
  
  // Single page: "5"
  if (!trimmed.includes(':')) {
    const pageNum = parseInt(trimmed, 10);
    if (isNaN(pageNum) || pageNum < 1 || pageNum > totalPages) {
      throw new Error(`Invalid page number: ${trimmed}. Must be between 1 and ${totalPages}`);
    }
    return [pageNum];
  }
  
  // Range with colon: "5:10", "7:", ":5"
  const parts = trimmed.split(':');
  if (parts.length !== 2) {
    throw new Error(`Invalid page range format: ${trimmed}. Use formats like "5", "5:10", "7:", or ":5"`);
  }
  
  let start = 1;
  let end = totalPages;
  
  if (parts[0].trim()) {
    start = parseInt(parts[0].trim(), 10);
    if (isNaN(start) || start < 1) {
      throw new Error(`Invalid start page: ${parts[0]}. Must be a positive number`);
    }
  }
  
  if (parts[1].trim()) {
    end = parseInt(parts[1].trim(), 10);
    if (isNaN(end) || end < 1) {
      throw new Error(`Invalid end page: ${parts[1]}. Must be a positive number`);
    }
  }
  
  if (start > end) {
    throw new Error(`Invalid page range: start page ${start} is greater than end page ${end}`);
  }
  
  if (start > totalPages) {
    throw new Error(`Start page ${start} exceeds document length of ${totalPages} pages`);
  }
  
  if (end > totalPages) {
    end = totalPages;
  }
  
  const pages: number[] = [];
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }
  
  return pages;
}

/**
 * Parse search pattern and create RegExp object
 * Supports /pattern/flags format or plain text
 */
function parseSearchPattern(pattern: string): { regex: RegExp; isRegex: boolean } {
  // Check if pattern is in /pattern/flags format
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    const regexPattern = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    
    // Validate flags
    const validFlags = /^[gimsuvy]*$/;
    if (!validFlags.test(flags)) {
      throw new Error(`Invalid regex flags: ${flags}. Valid flags are g, i, m, s, u, v, y`);
    }
    
    try {
      return { regex: new RegExp(regexPattern, flags), isRegex: true };
    } catch (error) {
      throw new Error(`Invalid regex pattern: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    // Treat as literal string - escape special regex characters
    const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { regex: new RegExp(escapedPattern, 'gi'), isRegex: false };
  }
}

/**
 * Extract context snippet around a match
 */
function extractContext(text: string, matchStart: number, matchEnd: number, contextChars: number): {
  snippet: string;
  matchStartInSnippet: number;
  matchEndInSnippet: number;
} {
  const start = Math.max(0, matchStart - contextChars);
  const end = Math.min(text.length, matchEnd + contextChars);
  const snippet = text.slice(start, end);
  
  return {
    snippet,
    matchStartInSnippet: matchStart - start,
    matchEndInSnippet: matchEnd - start,
  };
}

/**
 * Search for pattern in text with timeout protection
 */
async function searchWithTimeout(text: string, regex: RegExp, timeoutMs: number): Promise<RegExpMatchArray[]> {
  return new Promise<RegExpMatchArray[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Search timed out after ${timeoutMs}ms - pattern may be too complex`));
    }, timeoutMs);
    
    try {
      const matches: RegExpMatchArray[] = [];
      let match: RegExpMatchArray | null;
      
      // Reset regex lastIndex to ensure consistent behavior
      regex.lastIndex = 0;
      
      while ((match = regex.exec(text)) !== null) {
        matches.push(match);
        
        // Prevent infinite loop on zero-width matches
        if (match.index === regex.lastIndex) {
          regex.lastIndex++;
        }
        
        // Safety check to prevent runaway regex
        if (matches.length > 10000) {
          throw new Error('Too many matches found (>10000) - pattern may be too broad');
        }
      }
      
      clearTimeout(timeout);
      resolve(matches);
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

/**
 * Extract text from PDF using native PDF.js method
 */
async function extractTextNative(pdfBuffer: Buffer, pageNumbers: number[]): Promise<string[]> {
  let pdfDoc: any;
  
  // Suppress console output during PDF.js operations to prevent stdout contamination
  suppressConsoleOutput();
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  } finally {
    restoreConsoleOutput();
  }
  
  const texts: string[] = [];
  
  for (const pageNum of pageNumbers) {
    try {
      // Suppress console output for each page operation as well
      suppressConsoleOutput();
      let page: any;
      let textContent: any;
      try {
        page = await pdfDoc.getPage(pageNum);
        textContent = await page.getTextContent();
      } finally {
        restoreConsoleOutput();
      }
      
      const textItems = textContent.items as any[];
      
      // Combine text items with spacing
      let pageText = '';
      for (let i = 0; i < textItems.length; i++) {
        const item = textItems[i];
        if (item.str) {
          pageText += item.str;
          
          // Add space if next item is on same line but has gap
          if (i < textItems.length - 1) {
            const nextItem = textItems[i + 1];
            if (nextItem.str && item.transform[5] === nextItem.transform[5]) {
              // Same line, check for gap
              const gap = nextItem.transform[4] - item.transform[4] - item.width;
              if (gap > 5) {
                pageText += ' ';
              }
            } else if (nextItem.str) {
              // Different line, add newline
              pageText += '\n';
            }
          }
        }
      }
      
      texts.push(pageText.trim());
    } catch (error) {
      log('warn', `Failed to extract text from page ${pageNum}`, { error });
      texts.push('');
    }
  }
  
  return texts;
}


/**
 * Extract text using hybrid approach (enhanced native extraction with better error handling)
 */
async function extractTextHybrid(pdfBuffer: Buffer, pdfPath: string, pageNumbers: number[]): Promise<string[]> {
  try {
    // Use native extraction with enhanced error handling
    const nativeTexts = await extractTextNative(pdfBuffer, pageNumbers);
    
    // Check if pages have very little text (likely scanned PDFs)
    const results: string[] = [];
    let scannedPageCount = 0;
    
    for (let i = 0; i < nativeTexts.length; i++) {
      const text = nativeTexts[i];
      results.push(text);
      
      // Count pages with very little text
      if (text.trim().length < 50) {
        scannedPageCount++;
      }
    }
    
    // Log warning if many pages appear to be scanned
    if (scannedPageCount > 0) {
      log('warn', `${scannedPageCount} page(s) extracted very little text - may be scanned/image-based content`);
    }
    
    return results;
  } catch (error) {
    log('error', 'Text extraction failed', { error });
    throw error;
  }
}

/**
 * Convert image buffer to base64 with optimization
 */
async function imageToBase64(
  imageBuffer: Buffer, 
  options: {
    format: 'png' | 'jpeg';
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
  }
): Promise<{ data: string; mimeType: string; metadata: any }> {
  try {
    let processor = sharp(imageBuffer);
    
    // Get original metadata
    const originalMetadata = await processor.metadata();
    
    // Apply resizing if specified
    if (options.maxWidth || options.maxHeight) {
      processor = processor.resize(options.maxWidth, options.maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      });
    }
    
    // Apply format and quality
    if (options.format === 'jpeg') {
      processor = processor.jpeg({ quality: options.quality || 85 });
    } else {
      processor = processor.png({ compressionLevel: 6 });
    }
    
    const processedBuffer = await processor.toBuffer();
    const processedMetadata = await sharp(processedBuffer).metadata();
    
    const base64 = processedBuffer.toString('base64');
    const mimeType = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    
    return {
      data: base64,
      mimeType,
      metadata: {
        original: {
          width: originalMetadata.width,
          height: originalMetadata.height,
          size: imageBuffer.length
        },
        processed: {
          width: processedMetadata.width,
          height: processedMetadata.height,
          size: processedBuffer.length,
          format: options.format,
          quality: options.quality
        }
      }
    };
  } catch (error) {
    throw new Error(`Image processing failed: ${error}`);
  }
}

/**
 * Extract images from PDF pages using pdf-to-png-converter and convert to base64
 */
async function extractPdfImages(
  pdfPath: string,
  pageNumbers: number[],
  options: {
    format: 'png' | 'jpeg';
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
  }
): Promise<Array<{ page: number; image: any; metadata: any; error?: string }>> {
  const results: Array<{ page: number; image: any; metadata: any; error?: string }> = [];
  
  try {
    log('info', `Extracting images from PDF pages: ${pageNumbers.join(', ')}`);
    
    // Convert PDF to PNG images (extract all pages first, then filter)
    const pngPages = await pdfToPng(pdfPath, {
      disableFontFace: false,
      useSystemFonts: false,
      viewportScale: 2.0, // High quality scaling
      pagesToProcess: pageNumbers.length <= 10 ? pageNumbers : undefined // Only specify if reasonable count
    });
    
    log('info', `Successfully converted ${pngPages.length} pages to PNG`);
    
    // Process each requested page
    for (const pageNum of pageNumbers) {
      try {
        // Find the corresponding page in the results
        const pageData = pngPages.find(p => p.pageNumber === pageNum);
        
        if (pageData && pageData.content) {
          log('info', `Processing image for page ${pageNum}`);
          
          // Convert to base64 with optimization
          const processed = await imageToBase64(pageData.content, options);
          
          // Check size limit (1MB for token efficiency)
          const sizeInMB = processed.metadata.processed.size / (1024 * 1024);
          if (sizeInMB > 1) {
            log('warn', `Image for page ${pageNum} is ${sizeInMB.toFixed(2)}MB, consider reducing quality or size`);
          }
          
          results.push({
            page: pageNum,
            image: {
              type: "image",
              data: processed.data,
              mimeType: processed.mimeType
            },
            metadata: {
              ...processed.metadata,
              originalDimensions: {
                width: pageData.width,
                height: pageData.height
              }
            }
          });
        } else {
          results.push({
            page: pageNum,
            image: null,
            metadata: null,
            error: `Page ${pageNum} not found in PDF conversion results`
          });
        }
      } catch (error) {
        log('warn', `Image processing failed for page ${pageNum}`, { error });
        results.push({
          page: pageNum,
          image: null,
          metadata: null,
          error: `Image processing failed: ${error}`
        });
      }
    }
  } catch (error) {
    log('error', 'PDF to PNG conversion failed', { error });
    throw new Error(`PDF image extraction failed: ${error}`);
  }
  
  return results;
}

/**
 * Search PDF using extract-all-then-search strategy
 */
async function searchPdfComprehensive(
  pdfPath: string,
  pageNumbers: number[],
  searchPattern: string,
  contextChars: number,
  searchTimeout: number
): Promise<{
  matches: Array<{
    page: number;
    matchCount: number;
    snippets: Array<{
      text: string;
      matchStart: number;
      matchEnd: number;
    }>;
  }>;
  errors: string[];
  pagesScanned: number;
}> {
  const results: Array<{
    page: number;
    matchCount: number;
    snippets: Array<{
      text: string;
      matchStart: number;
      matchEnd: number;
    }>;
  }> = [];
  const errors: string[] = [];
  
  try {
    // Extract text from all pages using hybrid approach
    log('info', `Extracting text from ${pageNumbers.length} pages for comprehensive search`);
    const pdfBuffer = await safeReadFile(pdfPath);
    const pageTexts = await extractTextHybrid(pdfBuffer, pdfPath, pageNumbers);
    
    // Parse search pattern
    const { regex } = parseSearchPattern(searchPattern);
    
    // Search each page
    for (let i = 0; i < pageNumbers.length; i++) {
      const pageNum = pageNumbers[i];
      const pageText = pageTexts[i];
      
      if (!pageText || pageText.trim().length === 0) {
        errors.push(`Page ${pageNum}: No text extracted`);
        continue;
      }
      
      try {
        // Search with timeout protection
        const matches = await searchWithTimeout(pageText, new RegExp(regex.source, regex.flags), searchTimeout);
        
        if (matches.length > 0) {
          const snippets = matches.map(match => {
            const context = extractContext(pageText, match.index!, match.index! + match[0].length, contextChars);
            return {
              text: context.snippet,
              matchStart: context.matchStartInSnippet,
              matchEnd: context.matchEndInSnippet,
            };
          });
          
          results.push({
            page: pageNum,
            matchCount: matches.length,
            snippets,
          });
        }
      } catch (searchError) {
        errors.push(`Page ${pageNum}: Search failed - ${searchError}`);
      }
    }
    
    return {
      matches: results,
      errors,
      pagesScanned: pageNumbers.length,
    };
  } catch (error) {
    throw new Error(`Comprehensive search failed: ${error}`);
  }
}

/**
 * Search PDF using page-by-page strategy with early stopping
 */
async function searchPdfPageByPage(
  pdfPath: string,
  pageNumbers: number[],
  searchPattern: string,
  contextChars: number,
  searchTimeout: number,
  maxResults?: number,
  maxPagesScanned?: number
): Promise<{
  matches: Array<{
    page: number;
    matchCount: number;
    snippets: Array<{
      text: string;
      matchStart: number;
      matchEnd: number;
    }>;
  }>;
  errors: string[];
  pagesScanned: number;
  completed: boolean;
  stoppedReason?: 'max_results' | 'max_pages' | 'completed';
}> {
  const results: Array<{
    page: number;
    matchCount: number;
    snippets: Array<{
      text: string;
      matchStart: number;
      matchEnd: number;
    }>;
  }> = [];
  const errors: string[] = [];
  let totalMatchCount = 0;
  let pagesScanned = 0;
  
  // Parse search pattern once
  const { regex } = parseSearchPattern(searchPattern);
  
  log('info', `Starting page-by-page search with limits: max_results=${maxResults}, max_pages=${maxPagesScanned}`);
  
  for (const pageNum of pageNumbers) {
    // Check if we should stop scanning more pages
    if (maxPagesScanned && pagesScanned >= maxPagesScanned) {
      return {
        matches: results,
        errors,
        pagesScanned,
        completed: false,
        stoppedReason: 'max_pages',
      };
    }
    
    pagesScanned++;
    
    try {
      // Extract text from single page using hybrid approach
      const pdfBuffer = await safeReadFile(pdfPath);
      const pageTexts = await extractTextHybrid(pdfBuffer, pdfPath, [pageNum]);
      const pageText = pageTexts[0];
      
      if (!pageText || pageText.trim().length === 0) {
        errors.push(`Page ${pageNum}: No text extracted`);
        continue;
      }
      
      // Search with timeout protection
      const matches = await searchWithTimeout(pageText, new RegExp(regex.source, regex.flags), searchTimeout);
      
      if (matches.length > 0) {
        const snippets = matches.map(match => {
          const context = extractContext(pageText, match.index!, match.index! + match[0].length, contextChars);
          return {
            text: context.snippet,
            matchStart: context.matchStartInSnippet,
            matchEnd: context.matchEndInSnippet,
          };
        });
        
        results.push({
          page: pageNum,
          matchCount: matches.length,
          snippets,
        });
        
        totalMatchCount += matches.length;
        
        // Check if we've reached max results
        if (maxResults && totalMatchCount >= maxResults) {
          return {
            matches: results,
            errors,
            pagesScanned,
            completed: false,
            stoppedReason: 'max_results',
          };
        }
      }
    } catch (searchError) {
      errors.push(`Page ${pageNum}: Search failed - ${searchError}`);
    }
  }
  
  return {
    matches: results,
    errors,
    pagesScanned,
    completed: true,
    stoppedReason: 'completed',
  };
}

/**
 * Types for PDF outline/TOC structure
 */
interface OutlineItem {
  title: string;
  level: number;
  bold?: boolean;
  italic?: boolean;
  color?: [number, number, number];
  page?: number;
  destination?: string;
  url?: string;
  children?: OutlineItem[];
}

interface OutlineResult {
  file_path: string;
  has_outline: boolean;
  outline_items: OutlineItem[];
  summary: {
    total_items: number;
    max_depth: number;
    items_with_pages: number;
    items_with_urls: number;
  };
}

/**
 * Parse PDF destination object to get page number
 */
function parseDestination(dest: any, pdfDoc: any): number | undefined {
  try {
    if (!dest || !Array.isArray(dest) || dest.length === 0) {
      return undefined;
    }
    
    // First element should be a page reference
    const pageRef = dest[0];
    if (!pageRef || typeof pageRef !== 'object') {
      return undefined;
    }
    
    // Get page index and convert to 1-based page number
    const pageIndex = pdfDoc._pagePromises.findIndex((p: any) => 
      p && p._pageInfo && p._pageInfo.ref === pageRef
    );
    
    return pageIndex >= 0 ? pageIndex + 1 : undefined;
  } catch (error) {
    log('warn', 'Failed to parse PDF destination', { error });
    return undefined;
  }
}

/**
 * Process outline items recursively
 */
function processOutlineItems(
  items: any[], 
  level: number = 0,
  maxDepth?: number,
  pdfDoc?: any,
  includeDestinations: boolean = true
): OutlineItem[] {
  if (!items || items.length === 0) {
    return [];
  }
  
  if (maxDepth !== undefined && level >= maxDepth) {
    return [];
  }
  
  const processedItems: OutlineItem[] = [];
  
  for (const item of items) {
    try {
      const outlineItem: OutlineItem = {
        title: item.title || '',
        level,
        bold: item.bold || false,
        italic: item.italic || false,
      };
      
      // Add color if present
      if (item.color && Array.isArray(item.color) && item.color.length === 3) {
        outlineItem.color = item.color as [number, number, number];
      }
      
      // Add URL if present
      if (item.url) {
        outlineItem.url = item.url;
      }
      
      // Parse destination to page number if requested
      if (includeDestinations && item.dest && pdfDoc) {
        const pageNum = parseDestination(item.dest, pdfDoc);
        if (pageNum !== undefined) {
          outlineItem.page = pageNum;
        }
        if (item.dest) {
          outlineItem.destination = JSON.stringify(item.dest);
        }
      }
      
      // Process children recursively
      if (item.items && item.items.length > 0) {
        outlineItem.children = processOutlineItems(
          item.items, 
          level + 1, 
          maxDepth, 
          pdfDoc, 
          includeDestinations
        );
      }
      
      processedItems.push(outlineItem);
    } catch (error) {
      log('warn', `Failed to process outline item: ${item.title}`, { error });
    }
  }
  
  return processedItems;
}

/**
 * Flatten outline structure to a linear list
 */
function flattenOutlineItems(items: OutlineItem[]): OutlineItem[] {
  const flattened: OutlineItem[] = [];
  
  for (const item of items) {
    // Add current item (without children to avoid recursion)
    const flatItem: OutlineItem = { ...item };
    delete flatItem.children;
    flattened.push(flatItem);
    
    // Add children recursively
    if (item.children && item.children.length > 0) {
      flattened.push(...flattenOutlineItems(item.children));
    }
  }
  
  return flattened;
}

/**
 * Calculate outline statistics
 */
function calculateOutlineStats(items: OutlineItem[]): {
  total_items: number;
  max_depth: number;
  items_with_pages: number;
  items_with_urls: number;
} {
  let totalItems = 0;
  let maxDepth = 0;
  let itemsWithPages = 0;
  let itemsWithUrls = 0;
  
  function countItems(items: OutlineItem[]): void {
    for (const item of items) {
      totalItems++;
      maxDepth = Math.max(maxDepth, item.level + 1);
      
      if (item.page !== undefined) {
        itemsWithPages++;
      }
      
      if (item.url) {
        itemsWithUrls++;
      }
      
      if (item.children && item.children.length > 0) {
        countItems(item.children);
      }
    }
  }
  
  countItems(items);
  
  return {
    total_items: totalItems,
    max_depth: maxDepth,
    items_with_pages: itemsWithPages,
    items_with_urls: itemsWithUrls,
  };
}

/**
 * Download PDF from URL to PDF agent home directory
 */
async function downloadPdfFromUrl(
  url: string, 
  subfolder: string = "downloads", 
  filename?: string
): Promise<{ success: boolean; filePath?: string; error?: string; metadata?: any }> {
  try {
    log('info', `Starting PDF download from URL: ${url}`);
    
    // Ensure PDF agent home directory exists
    const pdfAgentHome = await ensurePdfAgentHome();
    const downloadDir = join(pdfAgentHome, subfolder);
    
    // Create download directory if it doesn't exist
    await mkdir(downloadDir, { recursive: true });
    
    // Generate filename if not provided
    let finalFilename = filename;
    if (!finalFilename) {
      try {
        const urlObj = new URL(url);
        finalFilename = basename(urlObj.pathname) || `download_${Date.now()}.pdf`;
        
        // Ensure .pdf extension
        if (!finalFilename.toLowerCase().endsWith('.pdf')) {
          finalFilename += '.pdf';
        }
      } catch {
        finalFilename = `download_${Date.now()}.pdf`;
      }
    } else {
      // Ensure .pdf extension for provided filename
      if (!finalFilename.toLowerCase().endsWith('.pdf')) {
        finalFilename += '.pdf';
      }
    }
    
    const filePath = join(downloadDir, finalFilename);
    
    // Check if file already exists
    if (await fileExists(filePath)) {
      return {
        success: false,
        error: `File already exists at ${filePath}. Please provide a different filename or delete the existing file.`
      };
    }
    
    log('info', `Downloading PDF to: ${filePath}`);
    
    // Download the file with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPERATION_TIMEOUT);
    
    try {
      const response = await fetch(url, { 
        signal: controller.signal,
        headers: {
          'User-Agent': 'PDF-Agent-MCP/1.0.0'
        }
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`
        };
      }
      
      // Check content type
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/pdf') && !contentType.includes('application/octet-stream')) {
        log('warn', `Content-Type is not PDF: ${contentType}`);
      }
      
      // Get content length for size check
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `File too large: ${(parseInt(contentLength) / 1024 / 1024).toFixed(1)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`
        };
      }
      
      // Stream the response to file
      const fileStream = createWriteStream(filePath);
      
      if (!response.body) {
        return {
          success: false,
          error: 'Empty response body'
        };
      }
      
      await pipeline(response.body as any, fileStream);
      
      // Verify the downloaded file
      const stats = await stat(filePath);
      if (stats.size === 0) {
        return {
          success: false,
          error: 'Downloaded file is empty'
        };
      }
      
      if (stats.size > MAX_FILE_SIZE) {
        // Clean up oversized file
        try {
          await stat(filePath);
          await import('fs').then(fs => fs.promises.unlink(filePath));
        } catch {}
        return {
          success: false,
          error: `Downloaded file too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`
        };
      }
      
      // Try to validate it's a PDF by reading the header
      try {
        const buffer = await readFile(filePath, { encoding: null });
        if (!buffer.subarray(0, 4).toString('ascii').startsWith('%PDF')) {
          log('warn', 'Downloaded file does not appear to be a valid PDF (missing PDF header)');
        }
      } catch (error) {
        log('warn', 'Could not validate PDF header', { error });
      }
      
      log('info', `PDF downloaded successfully: ${stats.size} bytes`);
      
      return {
        success: true,
        filePath: filePath,
        metadata: {
          filename: finalFilename,
          subfolder: subfolder,
          size_bytes: stats.size,
          size_mb: Number((stats.size / (1024 * 1024)).toFixed(2)),
          url: url,
          content_type: contentType,
          downloaded_at: new Date().toISOString()
        }
      };
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      // Clean up partial file on error
      try {
        if (await fileExists(filePath)) {
          await import('fs').then(fs => fs.promises.unlink(filePath));
        }
      } catch {}
      
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: `Download timeout after ${OPERATION_TIMEOUT / 1000} seconds`
        };
      }
      
      return {
        success: false,
        error: `Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
    
  } catch (error) {
    log('error', 'PDF download failed', { error });
    return {
      success: false,
      error: `Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Extract PDF outline/table of contents using PDF.js
 */
async function extractPdfOutline(
  pdfBuffer: Buffer, 
  filePath: string,
  options: {
    includeDestinations: boolean;
    maxDepth?: number;
    flattenStructure: boolean;
  }
): Promise<OutlineResult> {
  try {
    log('info', `Extracting PDF outline from ${filePath}`);
    
    // Load PDF document
    const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
    
    // Get outline
    const outline = await pdfDoc.getOutline();
    
    if (!outline || outline.length === 0) {
      log('info', 'PDF has no outline/bookmarks');
      return {
        file_path: filePath,
        has_outline: false,
        outline_items: [],
        summary: {
          total_items: 0,
          max_depth: 0,
          items_with_pages: 0,
          items_with_urls: 0,
        },
      };
    }
    
    log('info', `Found ${outline.length} top-level outline items`);
    
    // Process outline items
    let processedItems = processOutlineItems(
      outline, 
      0, 
      options.maxDepth, 
      pdfDoc, 
      options.includeDestinations
    );
    
    // Flatten structure if requested
    if (options.flattenStructure) {
      processedItems = flattenOutlineItems(processedItems);
    }
    
    // Calculate statistics
    const summary = calculateOutlineStats(processedItems);
    
    log('info', `Processed outline: ${summary.total_items} items, max depth ${summary.max_depth}`);
    
    return {
      file_path: filePath,
      has_outline: true,
      outline_items: processedItems,
      summary,
    };
    
  } catch (error) {
    log('error', 'Failed to extract PDF outline', { error });
    throw new Error(`PDF outline extraction failed: ${error}`);
  }
}

// Create the MCP server
const server = new Server({
  name: "pdf-agent-mcp",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
  },
});

// Enhanced file reading with size and timeout protection
async function safeReadFile(filePath: string, maxSize: number = MAX_FILE_SIZE): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`File read timeout after ${OPERATION_TIMEOUT/1000} seconds. The file may be too large or the system may be under heavy load. Try again or check file size.`));
    }, OPERATION_TIMEOUT);

    try {
      const stats = await stat(filePath);
      if (stats.size > maxSize) {
        clearTimeout(timeout);
        reject(new Error(`File too large: ${(stats.size/1024/1024).toFixed(1)}MB (max ${maxSize/1024/1024}MB). Please reduce file size or use a smaller PDF.`));
        return;
      }

      const content = await readFile(filePath);
      clearTimeout(timeout);
      resolve(content);
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && (error as any).code === 'ENOENT') {
        reject(new Error(`File not found: ${filePath}. Please check the file path and ensure the file exists.`));
      } else if (error instanceof Error && (error as any).code === 'EACCES') {
        reject(new Error(`Permission denied: ${filePath}. Please check file permissions and ensure you have read access.`));
      } else {
        reject(error);
      }
    }
  });
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_pdf_metadata",
        description: "Extract metadata and basic information from a PDF file, including page count, file size, creation dates, and document properties. Use either absolute_path for any location or relative_path for files in ~/pdf-agent/ directory.",
        inputSchema: {
          type: "object",
          properties: {
            absolute_path: {
              type: "string",
              description: "Absolute path to the PDF file (e.g., '/Users/john/documents/report.pdf')",
            },
            relative_path: {
              type: "string", 
              description: "Path relative to ~/pdf-agent/ directory (e.g., 'reports/annual.pdf')",
            },
            use_pdf_home: {
              type: "boolean",
              description: "Use PDF agent home directory for relative paths (default: true)",
              default: true,
            },
          },
        },
      },
      {
        name: "get_pdf_text",
        description: "Extract text from specific pages or page ranges of a PDF file using native text extraction. Supports Python-style slicing: '5' (single page), '5:10' (range), '7:' (from page 7 to end), ':5' (from start to page 5). Use either absolute_path for any location or relative_path for files in ~/pdf-agent/ directory. Note: Works best with PDFs containing native text; scanned PDFs may yield limited results.",
        inputSchema: {
          type: "object",
          properties: {
            absolute_path: {
              type: "string",
              description: "Absolute path to the PDF file (e.g., '/Users/john/documents/report.pdf')",
            },
            relative_path: {
              type: "string",
              description: "Path relative to ~/pdf-agent/ directory (e.g., 'reports/annual.pdf')",
            },
            use_pdf_home: {
              type: "boolean",
              description: "Use PDF agent home directory for relative paths (default: true)",
              default: true,
            },
            page_range: {
              type: "string",
              description: "Page range in enhanced Python-style format: '5' (page 5), '5:10' (pages 5-10), '7:' (page 7 to end), ':5' (start to page 5). Also supports comma-separated combinations: '1,3:5,7' (pages 1, 3-5, and 7), '1-3,7,10:' (pages 1-3, 7, and 10 to end). Default: '1:' (all pages)",
              default: "1:",
            },
            extraction_strategy: {
              type: "string",
              description: "Text extraction strategy: 'hybrid' (enhanced native extraction with better error handling), 'native' (standard PDF.js extraction). Default: 'hybrid'",
              enum: ["hybrid", "native"],
              default: "hybrid",
            },
            preserve_formatting: {
              type: "boolean",
              description: "Preserve text formatting and spacing (default: true)",
              default: true,
            },
            line_breaks: {
              type: "boolean", 
              description: "Preserve line breaks in extracted text (default: true)",
              default: true,
            },
          },
        },
      },
      {
        name: "get_pdf_images",
        description: "Extract specific pages or page ranges from a PDF as images for visual analysis. Essential for understanding charts, diagrams, tables, figures, mathematical equations, handwritten content, or any visual elements that text extraction cannot capture. Use when you need to see the actual layout, formatting, or visual content. Supports Python-style slicing: '5' (single page), '5:10' (range), '7:' (from page 7 to end), ':5' (from start to page 5). Returns images as base64-encoded data in MCP image format. Use either absolute_path for any location or relative_path for files in ~/pdf-agent/ directory.",
        inputSchema: {
          type: "object",
          properties: {
            absolute_path: {
              type: "string",
              description: "Absolute path to the PDF file (e.g., '/Users/john/documents/report.pdf')",
            },
            relative_path: {
              type: "string",
              description: "Path relative to ~/pdf-agent/ directory (e.g., 'reports/annual.pdf')",
            },
            use_pdf_home: {
              type: "boolean",
              description: "Use PDF agent home directory for relative paths (default: true)",
              default: true,
            },
            page_range: {
              type: "string",
              description: "Page range in enhanced Python-style format: '5' (page 5), '5:10' (pages 5-10), '7:' (page 7 to end), ':5' (start to page 5). Also supports comma-separated combinations: '1,3:5,7' (pages 1, 3-5, and 7), '1-3,7,10:' (pages 1-3, 7, and 10 to end). Default: '1:' (all pages)",
              default: "1:",
            },
            format: {
              type: "string",
              description: "Image format: 'jpeg' (smaller file size) or 'png' (higher quality). Default: 'jpeg'",
              enum: ["jpeg", "png"],
              default: "jpeg",
            },
            quality: {
              type: "number",
              description: "JPEG quality (1-100) - only applies to JPEG format. Higher = better quality but larger size. Default: 85",
              minimum: 1,
              maximum: 100,
              default: 85,
            },
            max_width: {
              type: "number",
              description: "Maximum image width in pixels (100-3000). Images will be resized proportionally if larger. Optional.",
              minimum: 100,
              maximum: 3000,
            },
            max_height: {
              type: "number", 
              description: "Maximum image height in pixels (100-3000). Images will be resized proportionally if larger. Optional.",
              minimum: 100,
              maximum: 3000,
            },
          },
        },
      },
      {
        name: "search_pdf",
        description: "Search for text patterns (including regex) within a PDF file and return matching pages with context snippets. Supports Python-style page ranges and early stopping for performance. Use /pattern/flags format for regex (e.g., '/budget|forecast/gi') or plain text for literal search.",
        inputSchema: {
          type: "object",
          properties: {
            absolute_path: {
              type: "string",
              description: "Absolute path to the PDF file (e.g., '/Users/john/documents/report.pdf')",
            },
            relative_path: {
              type: "string",
              description: "Path relative to ~/pdf-agent/ directory (e.g., 'reports/annual.pdf')",
            },
            use_pdf_home: {
              type: "boolean",
              description: "Use PDF agent home directory for relative paths (default: true)",
              default: true,
            },
            page_range: {
              type: "string",
              description: "Page range in enhanced Python-style format: '5' (page 5), '5:10' (pages 5-10), '7:' (page 7 to end), ':5' (start to page 5). Also supports comma-separated combinations: '1,3:5,7' (pages 1, 3-5, and 7), '1-3,7,10:' (pages 1-3, 7, and 10 to end). Default: '1:' (all pages)",
              default: "1:",
            },
            search_pattern: {
              type: "string",
              description: "Search pattern: '/regex/flags' format (e.g., '/budget|forecast/gi') or plain text for literal search. Required.",
            },
            max_results: {
              type: "number",
              description: "Stop after finding this many total matches. Optional - use for quick searches.",
              minimum: 1,
            },
            max_pages_scanned: {
              type: "number",
              description: "Stop after scanning this many pages. Optional - use for quick searches.",
              minimum: 1,
            },
            context_chars: {
              type: "number",
              description: "Number of characters to include before/after each match for context. Default: 150",
              minimum: 10,
              maximum: 1000,
              default: 150,
            },
            search_timeout: {
              type: "number",
              description: "Timeout for search operations in milliseconds. Default: 10000 (10 seconds)",
              minimum: 1000,
              maximum: 60000,
              default: 10000,
            },
          },
        },
      },
      {
        name: "get_pdf_outline",
        description: "Extract the table of contents (TOC) or outline/bookmarks structure from a PDF file. Returns hierarchical or flattened list of document sections with titles, page references, and navigation structure. Use either absolute_path for any location or relative_path for files in ~/pdf-agent/ directory.",
        inputSchema: {
          type: "object",
          properties: {
            absolute_path: {
              type: "string",
              description: "Absolute path to the PDF file (e.g., '/Users/john/documents/report.pdf')",
            },
            relative_path: {
              type: "string",
              description: "Path relative to ~/pdf-agent/ directory (e.g., 'reports/annual.pdf')",
            },
            use_pdf_home: {
              type: "boolean",
              description: "Use PDF agent home directory for relative paths (default: true)",
              default: true,
            },
            include_destinations: {
              type: "boolean",
              description: "Resolve internal destinations to page numbers when possible (default: true)",
              default: true,
            },
            max_depth: {
              type: "number",
              description: "Maximum nesting depth to process (1-10). Optional - limits deep hierarchies",
              minimum: 1,
              maximum: 10,
            },
            flatten_structure: {
              type: "boolean",
              description: "Return flat list instead of hierarchical tree structure (default: false)",
              default: false,
            },
          },
        },
      },
      {
        name: "download_pdf",
        description: "Download a PDF from a URL and save it to the PDF agent home directory. Downloads to a specified subfolder (default: 'downloads') and returns the full path of the downloaded PDF.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              format: "uri",
              description: "The URL of the PDF to download. Must be a valid HTTP/HTTPS URL.",
            },
            subfolder: {
              type: "string",
              description: "Subfolder within ~/pdf-agent/ to save the PDF (default: 'downloads'). Will be created if it doesn't exist.",
              default: "downloads",
            },
            filename: {
              type: "string",
              description: "Optional filename for the downloaded PDF. If not provided, will be derived from URL. Extension .pdf will be added if missing.",
            },
          },
          required: ["url"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_pdf_metadata": {
        const { absolute_path, relative_path, use_pdf_home } = GetPdfMetadataSchema.parse(args);
        
        try {
          // Resolve the final path based on parameters
          let resolvedPath: string;
          
          if (use_pdf_home && relative_path) {
            // Use relative path from PDF agent home directory
            const pdfAgentHome = await ensurePdfAgentHome();
            resolvedPath = join(pdfAgentHome, relative_path);
          } else if (absolute_path) {
            // Use absolute path directly
            if (!isAbsolute(absolute_path)) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ 
                      error: `Path '${absolute_path}' is not absolute. Use relative_path parameter for relative paths or provide a full absolute path.` 
                    }),
                  },
                ],
              };
            }
            resolvedPath = absolute_path;
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ 
                    error: `Must provide either 'absolute_path' or 'relative_path'. Examples: {"absolute_path": "/Users/john/document.pdf"} or {"relative_path": "reports/annual.pdf"}` 
                  }),
                },
              ],
            };
          }
          
          if (!(await fileExists(resolvedPath))) {
            const pathType = relative_path ? 'relative path' : 'absolute path';
            const homeInfo = relative_path ? ` (resolved from ~/pdf-agent/ to ${resolvedPath})` : '';
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ 
                    error: `PDF file not found at ${pathType}: ${relative_path || absolute_path}${homeInfo}. Please check the file path and ensure the file exists.` 
                  }),
                },
              ],
            };
          }

          // Read the PDF file
          const pdfBuffer = await safeReadFile(resolvedPath);
          
          // Get file stats
          const stats = await stat(resolvedPath);
          
          // Parse PDF to get metadata and page count
          // Try loading with encryption ignored first for encrypted PDFs
          let pdfDoc: PDFDocument;
          try {
            pdfDoc = await PDFDocument.load(pdfBuffer);
          } catch (error) {
            if (error instanceof Error && error.message.includes('encrypted')) {
              pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
            } else {
              throw error;
            }
          }
          
          // Get page count
          const pageCount = pdfDoc.getPageCount();
          
          // Extract metadata from PDF with error handling
          const title = pdfDoc.getTitle();
          const author = pdfDoc.getAuthor();
          const subject = pdfDoc.getSubject();
          const creator = pdfDoc.getCreator();
          const producer = pdfDoc.getProducer();
          
          // Handle potentially corrupted dates
          let creationDate: Date | null = null;
          let modificationDate: Date | null = null;
          
          try {
            creationDate = pdfDoc.getCreationDate() || null;
          } catch (e) {
            // Ignore corrupted creation date
          }
          
          try {
            modificationDate = pdfDoc.getModificationDate() || null;
          } catch (e) {
            // Ignore corrupted modification date
          }
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  file_path: resolvedPath,
                  pages: pageCount,
                  file_size_bytes: stats.size,
                  file_size_mb: Number((stats.size / (1024 * 1024)).toFixed(2)),
                  created_date: stats.birthtime?.toISOString() || null,
                  modified_date: stats.mtime?.toISOString() || null,
                  title: title || null,
                  author: author || null,
                  subject: subject || null,  
                  creator: creator || null,
                  producer: producer || null,
                  creation_date: creationDate?.toISOString() || null,
                  modification_date: modificationDate?.toISOString() || null,
                  encrypted: false, // We handle encrypted PDFs by ignoring encryption
                }),
              },
            ],
          };
        } catch (e) {
          const providedPath = relative_path || absolute_path || 'unknown';
          const pathType = relative_path ? 'relative path' : 'absolute path';
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ 
                  error: `Error processing PDF at ${pathType} '${providedPath}': ${e}. Please ensure the file is a valid PDF and not corrupted.` 
                }),
              },
            ],
          };
        }
      }

      case "get_pdf_text": {
        const { 
          absolute_path, 
          relative_path, 
          use_pdf_home, 
          page_range, 
          extraction_strategy, 
          preserve_formatting, 
          line_breaks 
        } = GetPdfTextSchema.parse(args);
        
        try {
          // Resolve the final path based on parameters (same logic as metadata tool)
          let resolvedPath: string;
          
          if (use_pdf_home && relative_path) {
            // Use relative path from PDF agent home directory
            const pdfAgentHome = await ensurePdfAgentHome();
            resolvedPath = join(pdfAgentHome, relative_path);
          } else if (absolute_path) {
            // Use absolute path directly
            if (!isAbsolute(absolute_path)) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ 
                      error: `Path '${absolute_path}' is not absolute. Use relative_path parameter for relative paths or provide a full absolute path.` 
                    }),
                  },
                ],
              };
            }
            resolvedPath = absolute_path;
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ 
                    error: `Must provide either 'absolute_path' or 'relative_path'. Examples: {"absolute_path": "/Users/john/document.pdf"} or {"relative_path": "reports/annual.pdf"}` 
                  }),
                },
              ],
            };
          }
          
          if (!(await fileExists(resolvedPath))) {
            const pathType = relative_path ? 'relative path' : 'absolute path';
            const homeInfo = relative_path ? ` (resolved from ~/pdf-agent/ to ${resolvedPath})` : '';
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ 
                    error: `PDF file not found at ${pathType}: ${relative_path || absolute_path}${homeInfo}. Please check the file path and ensure the file exists.` 
                  }),
                },
              ],
            };
          }

          // Read the PDF file
          const pdfBuffer = await safeReadFile(resolvedPath);
          
          // Get PDF document to determine total pages
          let pdfDoc: PDFDocument;
          try {
            pdfDoc = await PDFDocument.load(pdfBuffer);
          } catch (error) {
            if (error instanceof Error && error.message.includes('encrypted')) {
              pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
            } else {
              throw error;
            }
          }
          
          const totalPages = pdfDoc.getPageCount();
          
          // Parse page range
          const pageNumbers = parsePageRange(page_range, totalPages);
          
          log('info', `Extracting text from ${pageNumbers.length} pages using ${extraction_strategy} strategy`, {
            pages: pageNumbers,
            strategy: extraction_strategy
          });
          
          // Extract text based on strategy
          let extractedTexts: string[];
          
          switch (extraction_strategy) {
            case "native":
              extractedTexts = await extractTextNative(pdfBuffer, pageNumbers);
              break;
            case "hybrid":
            default:
              extractedTexts = await extractTextHybrid(pdfBuffer, resolvedPath, pageNumbers);
              break;
          }
          
          // Format the results
          const results = pageNumbers.map((pageNum, index) => ({
            page: pageNum,
            text: extractedTexts[index] || '',
            word_count: (extractedTexts[index] || '').split(/\s+/).filter(word => word.length > 0).length,
            char_count: (extractedTexts[index] || '').length
          }));
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  file_path: resolvedPath,
                  total_pages: totalPages,
                  extracted_pages: pageNumbers.length,
                  page_range: page_range,
                  extraction_strategy: extraction_strategy,
                  results: results,
                  summary: {
                    total_text_length: results.reduce((sum, r) => sum + r.char_count, 0),
                    total_word_count: results.reduce((sum, r) => sum + r.word_count, 0),
                    pages_with_text: results.filter(r => r.text.trim().length > 0).length
                  }
                }),
              },
            ],
          };
        } catch (e) {
          const providedPath = relative_path || absolute_path || 'unknown';
          const pathType = relative_path ? 'relative path' : 'absolute path';
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ 
                  error: `Error extracting text from PDF at ${pathType} '${providedPath}': ${e}. Please ensure the file is a valid PDF and check the page range format.` 
                }),
              },
            ],
          };
        }
      }

      case "get_pdf_images": {
        const { 
          absolute_path, 
          relative_path, 
          use_pdf_home, 
          page_range, 
          format, 
          quality, 
          max_width, 
          max_height 
        } = GetPdfImagesSchema.parse(args);
        
        try {
          // Resolve the final path based on parameters (same logic as other tools)
          let resolvedPath: string;
          
          if (use_pdf_home && relative_path) {
            // Use relative path from PDF agent home directory
            const pdfAgentHome = await ensurePdfAgentHome();
            resolvedPath = join(pdfAgentHome, relative_path);
          } else if (absolute_path) {
            // Use absolute path directly
            if (!isAbsolute(absolute_path)) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ 
                      error: `Path '${absolute_path}' is not absolute. Use relative_path parameter for relative paths or provide a full absolute path.` 
                    }),
                  },
                ],
              };
            }
            resolvedPath = absolute_path;
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ 
                    error: `Must provide either 'absolute_path' or 'relative_path'. Examples: {"absolute_path": "/Users/john/document.pdf"} or {"relative_path": "reports/annual.pdf"}` 
                  }),
                },
              ],
            };
          }
          
          if (!(await fileExists(resolvedPath))) {
            const pathType = relative_path ? 'relative path' : 'absolute path';
            const homeInfo = relative_path ? ` (resolved from ~/pdf-agent/ to ${resolvedPath})` : '';
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ 
                    error: `PDF file not found at ${pathType}: ${relative_path || absolute_path}${homeInfo}. Please check the file path and ensure the file exists.` 
                  }),
                },
              ],
            };
          }

          // Read the PDF file to get total pages
          const pdfBuffer = await safeReadFile(resolvedPath);
          
          // Get PDF document to determine total pages
          let pdfDoc: PDFDocument;
          try {
            pdfDoc = await PDFDocument.load(pdfBuffer);
          } catch (error) {
            if (error instanceof Error && error.message.includes('encrypted')) {
              pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
            } else {
              throw error;
            }
          }
          
          const totalPages = pdfDoc.getPageCount();
          
          // Parse page range
          const pageNumbers = parsePageRange(page_range, totalPages);
          
          log('info', `Extracting images from ${pageNumbers.length} pages in ${format} format`, {
            pages: pageNumbers,
            format,
            quality,
            maxDimensions: { maxWidth: max_width, maxHeight: max_height }
          });
          
          // Extract images
          const imageResults = await extractPdfImages(resolvedPath, pageNumbers, {
            format,
            quality,
            maxWidth: max_width,
            maxHeight: max_height
          });
          
          // Prepare MCP response with mixed content (text summary + images)
          const content: any[] = [];
          
          // Add summary as text
          const summary = {
            file_path: resolvedPath,
            total_pages: totalPages,
            extracted_pages: pageNumbers.length,
            page_range: page_range,
            format: format,
            quality: quality,
            max_dimensions: {
              width: max_width || "original",
              height: max_height || "original"
            },
            summary: {
              successful_extractions: imageResults.filter(r => r.image !== null).length,
              failed_extractions: imageResults.filter(r => r.error).length,
              total_size_mb: imageResults
                .filter(r => r.metadata?.processed?.size)
                .reduce((sum, r) => sum + (r.metadata.processed.size / (1024 * 1024)), 0)
                .toFixed(2)
            }
          };
          
          content.push({
            type: "text",
            text: JSON.stringify(summary, null, 2)
          });
          
          // Add each successfully extracted image
          for (const result of imageResults) {
            if (result.image) {
              content.push(result.image);
            } else if (result.error) {
              content.push({
                type: "text",
                text: JSON.stringify({
                  page: result.page,
                  error: result.error
                })
              });
            }
          }
          
          return {
            content: content
          };
        } catch (e) {
          const providedPath = relative_path || absolute_path || 'unknown';
          const pathType = relative_path ? 'relative path' : 'absolute path';
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ 
                  error: `Error extracting images from PDF at ${pathType} '${providedPath}': ${e}. Please ensure the file is a valid PDF and check the page range format.` 
                }),
              },
            ],
          };
        }
      }

      case "search_pdf": {
        const { 
          absolute_path, 
          relative_path, 
          use_pdf_home, 
          page_range, 
          search_pattern,
          max_results,
          max_pages_scanned,
          context_chars,
          search_timeout
        } = SearchPdfSchema.parse(args);
        
        try {
          // Resolve the final path based on parameters
          let resolvedPath: string;
          if (absolute_path) {
            resolvedPath = resolve(absolute_path);
          } else {
            if (use_pdf_home) {
              const pdfAgentHome = await ensurePdfAgentHome();
              resolvedPath = resolve(pdfAgentHome, relative_path!);
            } else {
              resolvedPath = resolve(relative_path!);
            }
          }
          
          // Check if file exists
          if (!(await fileExists(resolvedPath))) {
            throw new Error(`PDF file not found at ${resolvedPath}. Please check the file path and ensure the file exists.`);
          }
          
          // Get PDF metadata to determine page count
          const pdfBuffer = await safeReadFile(resolvedPath);
          const pdfDoc = await PDFDocument.load(pdfBuffer);
          const totalPages = pdfDoc.getPageCount();
          
          // Parse page range
          const pageNumbers = parsePageRange(page_range, totalPages);
          
          // Validate search pattern
          let searchRegex: RegExp;
          let isRegexSearch: boolean;
          try {
            const parsed = parseSearchPattern(search_pattern);
            searchRegex = parsed.regex;
            isRegexSearch = parsed.isRegex;
          } catch (regexError) {
            throw new Error(`Invalid search pattern: ${regexError}`);
          }
          
          // Determine search strategy based on limits
          const hasLimits = max_results !== undefined || max_pages_scanned !== undefined;
          let searchResults: any;
          let searchStrategy: string;
          
          if (hasLimits) {
            // Use page-by-page search with early stopping
            searchStrategy = "page_by_page";
            searchResults = await searchPdfPageByPage(
              resolvedPath,
              pageNumbers,
              search_pattern,
              context_chars,
              search_timeout,
              max_results,
              max_pages_scanned
            );
          } else {
            // Use comprehensive search (extract all then search)
            searchStrategy = "extract_all";
            const comprehensiveResults = await searchPdfComprehensive(
              resolvedPath,
              pageNumbers,
              search_pattern,
              context_chars,
              search_timeout
            );
            searchResults = {
              ...comprehensiveResults,
              completed: true,
              stoppedReason: 'completed'
            };
          }
          
          // Create comprehensive summary
          const totalMatches = searchResults.matches.reduce((sum: number, page: any) => sum + page.matchCount, 0);
          const pagesWithMatches = searchResults.matches.length;
          
          const summary = {
            total_matches: totalMatches,
            pages_with_matches: pagesWithMatches,
            pages_scanned: searchResults.pagesScanned,
            total_pages_in_range: pageNumbers.length,
            search_strategy: searchStrategy,
            search_pattern: search_pattern,
            is_regex: isRegexSearch,
            completed: searchResults.completed,
            stopped_reason: searchResults.stoppedReason,
            context_chars: context_chars,
            timeout_ms: search_timeout,
            errors: searchResults.errors?.length || 0
          };
          
          // Prepare response content
          const content: any[] = [];
          
          // Add summary as first item
          content.push({
            type: "text",
            text: JSON.stringify(summary, null, 2)
          });
          
          // Add detailed results if matches found
          if (searchResults.matches.length > 0) {
            content.push({
              type: "text", 
              text: JSON.stringify({
                matches: searchResults.matches,
                errors: searchResults.errors || []
              }, null, 2)
            });
          }
          
          // Add error details if any
          if (searchResults.errors && searchResults.errors.length > 0) {
            content.push({
              type: "text",
              text: JSON.stringify({
                errors: searchResults.errors
              }, null, 2)
            });
          }
          
          return {
            content: content
          };
        } catch (e) {
          const providedPath = relative_path || absolute_path || 'unknown';
          const pathType = relative_path ? 'relative path' : 'absolute path';
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ 
                  error: `Error searching PDF at ${pathType} '${providedPath}': ${e}. Please ensure the file is a valid PDF, check the search pattern format, and verify the page range.` 
                }),
              },
            ],
          };
        }
      }

      case "get_pdf_outline": {
        const { absolute_path, relative_path, use_pdf_home, include_destinations, max_depth, flatten_structure } = GetPdfOutlineSchema.parse(args);
        
        try {
          // Resolve the final path based on parameters
          let resolvedPath: string;
          
          if (use_pdf_home && relative_path) {
            // Use relative path from PDF agent home directory
            const pdfAgentHome = await ensurePdfAgentHome();
            resolvedPath = join(pdfAgentHome, relative_path);
          } else if (absolute_path) {
            // Use absolute path directly
            if (!isAbsolute(absolute_path)) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ 
                      error: `Path '${absolute_path}' is not absolute. Use relative_path parameter for relative paths or provide a full absolute path.` 
                    }),
                  },
                ],
              };
            }
            resolvedPath = absolute_path;
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ 
                    error: `Must provide either 'absolute_path' or 'relative_path'. Examples: {"absolute_path": "/Users/john/document.pdf"} or {"relative_path": "reports/annual.pdf"}` 
                  }),
                },
              ],
            };
          }
          
          if (!(await fileExists(resolvedPath))) {
            const pathType = relative_path ? 'relative path' : 'absolute path';
            const homeInfo = relative_path ? ` (resolved from ~/pdf-agent/ to ${resolvedPath})` : '';
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ 
                    error: `PDF file not found at ${pathType} '${relative_path || absolute_path}'${homeInfo}. Please check the file path and ensure the file exists.` 
                  }),
                },
              ],
            };
          }
          
          // Read PDF file
          const pdfBuffer = await safeReadFile(resolvedPath);
          
          // Extract PDF outline
          const outlineResult = await extractPdfOutline(pdfBuffer, resolvedPath, {
            includeDestinations: include_destinations,
            maxDepth: max_depth,
            flattenStructure: flatten_structure,
          });
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(outlineResult, null, 2),
              },
            ],
          };
          
        } catch (e) {
          const providedPath = relative_path || absolute_path || 'unknown';
          const pathType = relative_path ? 'relative path' : 'absolute path';
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ 
                  error: `Error extracting PDF outline at ${pathType} '${providedPath}': ${e}. Please ensure the file is a valid PDF and check the file path.` 
                }),
              },
            ],
          };
        }
      }

      case "download_pdf": {
        const { url, subfolder, filename } = DownloadPdfSchema.parse(args);
        
        try {
          const result = await downloadPdfFromUrl(url, subfolder, filename);
          
          if (result.success && result.filePath) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    file_path: result.filePath,
                    metadata: result.metadata
                  }, null, 2),
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: result.error
                  }),
                },
              ],
            };
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: `Download failed: ${e instanceof Error ? e.message : 'Unknown error'}`
                }),
              },
            ],
          };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  try {
    log('info', 'Starting PDF Agent MCP Server', {
      version: '1.0.0',
      nodeVersion: process.version,
      platform: process.platform
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    log('info', 'PDF Agent MCP Server connected successfully');
  } catch (error) {
    log('error', 'Failed to start server', { error: error instanceof Error ? error.message : error });
    throw error;
  }
}

// Enhanced error handling with graceful shutdown
process.on('SIGINT', () => {
  log('info', 'Received SIGINT, shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('info', 'Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log('error', 'Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection', { reason });
  process.exit(1);
});

main().catch((error) => {
  log('error', 'Server startup failed', { error: error instanceof Error ? error.message : error });
  process.exit(1);
});