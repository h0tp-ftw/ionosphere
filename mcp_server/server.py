import os
import shutil
import asyncio
from pathlib import Path
from typing import Any, Dict, Optional
from mcp.server.fastmcp import FastMCP
from playwright.async_api import async_playwright, Page, Browser, BrowserContext

# Initialize FastMCP Server
mcp = FastMCP("Ionosphere")

# ---------------------------------------------------------------------------
# Filesystem Tool
# ---------------------------------------------------------------------------

@mcp.tool()
async def filesystem_manager(action: str, params: Dict[str, Any]) -> str:
    """
    Manage the local filesystem.
    
    Supported actions:
    - read_file: requires `path`
    - write_file: requires `path` and `content`
    - list_directory: requires `path`
    - search_files: requires `path` (directory) and `query` (string match)
    - make_directory: requires `path`
    - delete_path: requires `path`
    """
    try:
        path_str = params.get("path")
        if not path_str:
            return "Error: 'path' parameter is required for all filesystem actions."
        
        path = Path(path_str).resolve()
        
        if action == "read_file":
            if not path.is_file():
                return f"Error: File not found or is a directory: {path}"
            return path.read_text(encoding="utf-8")
            
        elif action == "write_file":
            content = params.get("content", "")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            return f"Successfully wrote to {path}"
            
        elif action == "list_directory":
            if not path.is_dir():
                return f"Error: Directory not found or is a file: {path}"
            items = []
            for item in path.iterdir():
                items.append(f"{item.name}{'/' if item.is_dir() else ''}")
            return "\n".join(items) if items else "Directory is empty"
            
        elif action == "search_files":
            if not path.is_dir():
                return f"Error: Directory not found or is a file: {path}"
            query = params.get("query", "")
            matches = []
            for ext_path in path.rglob("*"):
                if ext_path.is_file() and query.lower() in ext_path.name.lower():
                    matches.append(str(ext_path.relative_to(path)))
            return "\n".join(matches) if matches else f"No files matching '{query}' found."
            
        elif action == "make_directory":
            path.mkdir(parents=True, exist_ok=True)
            return f"Successfully created directory {path}"
            
        elif action == "delete_path":
            if not path.exists():
                return f"Error: Path does not exist: {path}"
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            return f"Successfully deleted {path}"
            
        else:
            return f"Error: Unknown action '{action}'"
            
    except Exception as e:
        return f"Filesystem Error ({action}): {str(e)}"

# ---------------------------------------------------------------------------
# Web Browser Tool
# ---------------------------------------------------------------------------

# Global Playwright state
_playwright = None
_browser: Optional[Browser] = None
_context: Optional[BrowserContext] = None
_page: Optional[Page] = None

async def _get_page() -> Page:
    global _playwright, _browser, _context, _page
    if _page is None:
        _playwright = await async_playwright().start()
        _browser = await _playwright.chromium.launch(headless=True)
        _context = await _browser.new_context()
        _page = await _context.new_page()
    return _page

@mcp.tool()
async def web_browser(action: str, params: Dict[str, Any]) -> str:
    """
    Automate a headless Chromium browser.
    
    Supported actions:
    - navigate: requires `url`
    - get_text: returns the innerText of the current page
    - click: requires `selector`
    - fill: requires `selector` and `value`
    - evaluate: requires `script` (JavaScript to execute)
    """
    try:
        page = await _get_page()
        
        if action == "navigate":
            url = params.get("url")
            if not url:
                return "Error: 'url' parameter is required for navigate."
            await page.goto(url, wait_until="domcontentloaded")
            return f"Successfully navigated to {page.url}"
            
        elif action == "get_text":
            # Extract readable text from the body
            return await page.evaluate("() => document.body.innerText")
            
        elif action == "click":
            selector = params.get("selector")
            if not selector:
                return "Error: 'selector' parameter is required for click."
            await page.click(selector)
            return f"Successfully clicked '{selector}'"
            
        elif action == "fill":
            selector = params.get("selector")
            value = params.get("value")
            if not selector or value is None:
                return "Error: 'selector' and 'value' parameters are required for fill."
            await page.fill(selector, str(value))
            return f"Successfully filled '{selector}' with '{value}'"
            
        elif action == "evaluate":
            script = params.get("script")
            if not script:
                return "Error: 'script' parameter is required for evaluate."
            result = await page.evaluate(script)
            return f"Result: {result}"
            
        else:
            return f"Error: Unknown action '{action}'"
            
    except Exception as e:
        return f"Browser Error ({action}): {str(e)}"

if __name__ == "__main__":
    # Stdio transport (default)
    mcp.run()
