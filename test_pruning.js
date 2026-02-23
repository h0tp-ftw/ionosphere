
const rooTools = ['read_file', 'list_files', 'apply_diff', 'search_files', 'execute_command', 'write_to_file'];
const openAiTools = [
    {
        name: 'read_file',
        function: {
            name: 'read_file',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string' }, offset: { type: 'number' } },
                required: ['path', 'offset', 'limit', 'mode', 'indentation']
            }
        }
    }
];

const namespacedTools = [];
for (const t of openAiTools) {
    const originalName = t.function?.name || t.name;
    const prefixedName = originalName.startsWith('ionosphere__') ? originalName : `ionosphere__${originalName}`;

    // Relax schemas for Roo's native tools to prevent validation loops
    if (rooTools.includes(originalName)) {
        const fn = t.function || t;
        if (fn.parameters?.required) {
            const essentials = {
                'read_file': ['path'],
                'list_files': ['path']
            };
            console.log(`Pruning ${originalName} required list from ${fn.parameters.required} to ${essentials[originalName]}`);
            fn.parameters.required = essentials[originalName] || fn.parameters.required;
        }
    }

    const prefixedTool = JSON.parse(JSON.stringify(t));
    if (prefixedTool.function) prefixedTool.function.name = prefixedName;
    else prefixedTool.name = prefixedName;
    namespacedTools.push(prefixedTool);

    if (originalName !== prefixedName) {
        const bareTool = JSON.parse(JSON.stringify(t));
        if (bareTool.function) bareTool.function.name = originalName;
        else bareTool.name = originalName;
        namespacedTools.push(bareTool);
    }
}

console.log('Result:', JSON.stringify(namespacedTools, null, 2));
