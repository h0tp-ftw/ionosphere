import asyncio
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

async def test():
    params = StdioServerParameters(command='python', args=['-m','mcp_server.server'])
    async with stdio_client(params) as (r,w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tools = await s.list_tools()
            names = [t.name for t in tools.tools]
            assert 'web_browser' in names and 'filesystem_manager' in names, names
            print('MCP tools OK:', names)

asyncio.run(test())
