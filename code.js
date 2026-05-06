"use strict";
figma.showUI(__html__, {
    width: 420,
    height: 560,
    themeColors: true,
});
const variableCache = new Map();
const collectionCache = new Map();
figma.ui.onmessage = async (msg) => {
    try {
        if (msg.type === 'fix-selection') {
            await fixSelection();
            return;
        }
        if (msg.type === 'fix-whole-file') {
            await fixWholeFile();
        }
    }
    catch (error) {
        postMessage({
            type: 'error',
            message: error instanceof Error ? error.message : 'Something went wrong.',
        });
    }
};
async function fixSelection() {
    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
        postMessage({
            type: 'error',
            message: 'Select exactly one component, component set, or frame.',
        });
        return;
    }
    const selectedNode = selection[0];
    if (!isSelectionRoot(selectedNode)) {
        postMessage({
            type: 'error',
            message: 'Selection must be a component, component set, or frame.',
        });
        return;
    }
    postProgress('Preparing variables', 'Building local color variable lookup...');
    const context = await createFixContext();
    postProgress('Fixing selection', `Scanning ${selectedNode.name}...`, 0, 1);
    if (selectedNode.type === 'FRAME') {
        await fixFrameRoot(selectedNode, context);
    }
    else {
        await fixComponentRoot(selectedNode, context);
    }
    postMessage({
        type: 'fix-complete',
        mode: 'selection',
        summary: context.summary,
        issues: dedupeIssues(context.issues),
    });
}
async function fixWholeFile() {
    postProgress('Loading file', 'Loading all pages before scanning components...');
    await figma.loadAllPagesAsync();
    postProgress('Preparing variables', 'Building local color variable lookup...');
    const context = await createFixContext();
    const roots = collectComponentRoots();
    if (roots.length === 0) {
        postMessage({
            type: 'fix-complete',
            mode: 'whole-file',
            summary: context.summary,
            issues: [],
        });
        return;
    }
    for (let index = 0; index < roots.length; index++) {
        const root = roots[index];
        postProgress('Fixing whole file', `Scanning ${getPageName(root)} / ${root.name}`, index + 1, roots.length);
        await fixComponentRoot(root, context);
        if (index % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    postMessage({
        type: 'fix-complete',
        mode: 'whole-file',
        summary: context.summary,
        issues: dedupeIssues(context.issues),
    });
}
async function createFixContext() {
    const lookup = await buildLocalVariableLookup();
    return {
        lookup,
        summary: {
            componentsScanned: 0,
            nodesScanned: 0,
            bindingsScanned: 0,
            fixed: 0,
            alreadyLocal: 0,
            skipped: 0,
            failed: 0,
        },
        issues: [],
    };
}
async function buildLocalVariableLookup() {
    var _a, _b;
    const localVariables = await figma.variables.getLocalVariablesAsync('COLOR');
    const byNameAndCollection = new Map();
    const byName = new Map();
    const localIds = new Set();
    for (const variable of localVariables) {
        const collection = await getCollectionByIdCached(variable.variableCollectionId);
        const collectionName = (_a = collection === null || collection === void 0 ? void 0 : collection.name) !== null && _a !== void 0 ? _a : '';
        const key = getVariableKey(variable.name, collectionName);
        localIds.add(variable.id);
        if (!byNameAndCollection.has(key)) {
            byNameAndCollection.set(key, variable);
        }
        const nameMatches = (_b = byName.get(variable.name)) !== null && _b !== void 0 ? _b : [];
        nameMatches.push(variable);
        byName.set(variable.name, nameMatches);
    }
    return { byNameAndCollection, byName, localIds };
}
function collectComponentRoots() {
    const roots = [];
    for (const page of figma.root.children) {
        for (const child of page.children) {
            collectComponentRootsRecursive(child, roots);
        }
    }
    return roots;
}
function collectComponentRootsRecursive(node, roots) {
    if (node.type === 'COMPONENT_SET') {
        roots.push(node);
        return;
    }
    if (node.type === 'COMPONENT') {
        roots.push(node);
        return;
    }
    if ('children' in node) {
        for (const child of node.children) {
            collectComponentRootsRecursive(child, roots);
        }
    }
}
async function fixComponentRoot(root, context) {
    context.summary.componentsScanned++;
    if (root.type === 'COMPONENT_SET') {
        for (const child of root.children) {
            if (child.type !== 'COMPONENT') {
                continue;
            }
            await scanNode(child, context, {
                componentId: root.id,
                componentName: root.name,
                componentType: root.type,
                pageName: getPageName(root),
                variantName: child.name,
            });
        }
        return;
    }
    await scanNode(root, context, {
        componentId: root.id,
        componentName: root.name,
        componentType: root.type,
        pageName: getPageName(root),
    });
}
async function fixFrameRoot(root, context) {
    context.summary.componentsScanned++;
    await scanNode(root, context, {
        componentId: root.id,
        componentName: root.name,
        componentType: root.type,
        pageName: getPageName(root),
    }, { skipComponentRoots: true });
}
async function scanNode(node, context, componentContext, options = {}) {
    if (options.skipComponentRoots && isComponentRoot(node)) {
        return;
    }
    context.summary.nodesScanned++;
    if (node.type === 'INSTANCE') {
        // Instances are scanned like other nodes in the MVP. Instance-specific
        // override handling can be added here if testing shows we need it.
    }
    await fixPaintBindings(node, context, componentContext, 'fills');
    await fixPaintBindings(node, context, componentContext, 'strokes');
    if ('children' in node) {
        for (const child of node.children) {
            await scanNode(child, context, componentContext, options);
        }
    }
}
async function fixPaintBindings(node, context, componentContext, field) {
    var _a, _b;
    const bindings = collectPaintBindings(node, field);
    for (const binding of bindings) {
        context.summary.bindingsScanned++;
        const currentVariable = await getVariableByIdCached(binding.variableId);
        if (!currentVariable) {
            context.summary.skipped++;
            context.issues.push(Object.assign(Object.assign({ reason: 'unresolved-variable' }, getIssueBase(componentContext, node, binding)), { detail: `Could not resolve variable reference ${binding.variableId}.` }));
            continue;
        }
        if (context.lookup.localIds.has(currentVariable.id)) {
            context.summary.alreadyLocal++;
            continue;
        }
        const currentCollection = await getCollectionByIdCached(currentVariable.variableCollectionId);
        const currentCollectionName = (_a = currentCollection === null || currentCollection === void 0 ? void 0 : currentCollection.name) !== null && _a !== void 0 ? _a : '';
        const localVariable = context.lookup.byNameAndCollection.get(getVariableKey(currentVariable.name, currentCollectionName));
        if (!localVariable) {
            const sameNameVariables = (_b = context.lookup.byName.get(currentVariable.name)) !== null && _b !== void 0 ? _b : [];
            context.summary.skipped++;
            if (sameNameVariables.length > 0) {
                const matchedCollectionNames = await getCollectionNames(sameNameVariables);
                context.issues.push(Object.assign(Object.assign({ reason: 'collection-mismatch' }, getIssueBase(componentContext, node, binding)), { variableName: currentVariable.name, collectionName: currentCollectionName, expectedCollectionName: currentCollectionName, matchedCollectionNames, detail: `Found "${currentVariable.name}" locally, but not in collection "${currentCollectionName}".` }));
                continue;
            }
            context.issues.push(Object.assign(Object.assign({ reason: 'missing-local-match' }, getIssueBase(componentContext, node, binding)), { variableName: currentVariable.name, collectionName: currentCollectionName, expectedCollectionName: currentCollectionName, detail: `No local color variable named "${currentVariable.name}" in collection "${currentCollectionName}".` }));
            continue;
        }
        try {
            applyPaintBinding(node, binding, localVariable);
            context.summary.fixed++;
        }
        catch (error) {
            context.summary.failed++;
            context.issues.push(Object.assign(Object.assign({ reason: 'apply-failed' }, getIssueBase(componentContext, node, binding)), { variableName: currentVariable.name, collectionName: currentCollectionName, expectedCollectionName: currentCollectionName, detail: error instanceof Error ? error.message : 'Could not apply local variable.' }));
        }
    }
}
function collectPaintBindings(node, field) {
    var _a;
    const bindings = [];
    const seen = new Set();
    const boundVariables = 'boundVariables' in node ? node.boundVariables : null;
    const directBindings = boundVariables === null || boundVariables === void 0 ? void 0 : boundVariables[field];
    if (Array.isArray(directBindings)) {
        for (let index = 0; index < directBindings.length; index++) {
            const alias = directBindings[index];
            if (isVariableAlias(alias)) {
                pushPaintBinding(bindings, seen, field, index, alias.id);
            }
        }
    }
    const paints = getPaints(node, field);
    if (Array.isArray(paints)) {
        for (let index = 0; index < paints.length; index++) {
            const paint = paints[index];
            if (!paint || paint.type !== 'SOLID') {
                continue;
            }
            const paintAlias = (_a = paint.boundVariables) === null || _a === void 0 ? void 0 : _a.color;
            if (isVariableAlias(paintAlias)) {
                pushPaintBinding(bindings, seen, field, index, paintAlias.id);
            }
        }
    }
    return bindings;
}
function pushPaintBinding(bindings, seen, field, index, variableId) {
    const key = `${field}:${index}:${variableId}`;
    if (seen.has(key)) {
        return;
    }
    seen.add(key);
    bindings.push({ field, index, variableId });
}
function applyPaintBinding(node, binding, variable) {
    const paints = getPaints(node, binding.field);
    if (!Array.isArray(paints)) {
        throw new Error(`Node does not expose ${binding.field}.`);
    }
    const paint = paints[binding.index];
    if (!paint || paint.type !== 'SOLID') {
        throw new Error(`Could not find a solid paint at ${binding.field}[${binding.index}].`);
    }
    const updatedPaints = [...paints];
    updatedPaints[binding.index] = figma.variables.setBoundVariableForPaint(paint, 'color', variable);
    setPaints(node, binding.field, updatedPaints);
}
function getPaints(node, field) {
    if (field === 'fills' && 'fills' in node) {
        return node.fills;
    }
    if (field === 'strokes' && 'strokes' in node) {
        return node.strokes;
    }
    return undefined;
}
function setPaints(node, field, paints) {
    if (field === 'fills' && 'fills' in node) {
        node.fills = paints;
        return;
    }
    if (field === 'strokes' && 'strokes' in node) {
        node.strokes = paints;
        return;
    }
    throw new Error(`Node does not support ${field}.`);
}
async function getVariableByIdCached(id) {
    var _a;
    if (!variableCache.has(id)) {
        variableCache.set(id, await figma.variables.getVariableByIdAsync(id));
    }
    return (_a = variableCache.get(id)) !== null && _a !== void 0 ? _a : null;
}
async function getCollectionByIdCached(id) {
    var _a;
    if (!collectionCache.has(id)) {
        collectionCache.set(id, await figma.variables.getVariableCollectionByIdAsync(id));
    }
    return (_a = collectionCache.get(id)) !== null && _a !== void 0 ? _a : null;
}
async function getCollectionNames(variables) {
    var _a;
    const names = [];
    for (const variable of variables) {
        const collection = await getCollectionByIdCached(variable.variableCollectionId);
        names.push((_a = collection === null || collection === void 0 ? void 0 : collection.name) !== null && _a !== void 0 ? _a : 'Unknown collection');
    }
    return Array.from(new Set(names));
}
function getIssueBase(componentContext, node, binding) {
    return {
        componentName: componentContext.componentName,
        componentType: componentContext.componentType,
        pageName: componentContext.pageName,
        variantName: componentContext.variantName,
        nodeName: node.name,
        nodeType: node.type,
        field: `${binding.field}[${binding.index}]`,
        variableId: binding.variableId,
    };
}
function dedupeIssues(issues) {
    var _a;
    const deduped = [];
    const seen = new Set();
    for (const issue of issues) {
        const key = [
            issue.reason,
            issue.pageName,
            issue.componentName,
            (_a = issue.variantName) !== null && _a !== void 0 ? _a : '',
            issue.nodeName,
            issue.field,
            issue.variableId,
            issue.detail,
        ].join('::');
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(issue);
        }
    }
    return deduped;
}
function getVariableKey(variableName, collectionName) {
    return `${normalizeName(collectionName)}::${normalizeName(variableName)}`;
}
function normalizeName(name) {
    return name.trim().toLowerCase();
}
function getPageName(node) {
    let current = node;
    while (current === null || current === void 0 ? void 0 : current.parent) {
        if (current.parent.type === 'PAGE') {
            return current.parent.name;
        }
        current = current.parent;
    }
    return figma.currentPage.name;
}
function isComponentRoot(node) {
    return node.type === 'COMPONENT' || node.type === 'COMPONENT_SET';
}
function isSelectionRoot(node) {
    return isComponentRoot(node) || node.type === 'FRAME';
}
function isVariableAlias(value) {
    return (typeof value === 'object'
        && value !== null
        && 'type' in value
        && value.type === 'VARIABLE_ALIAS'
        && 'id' in value
        && typeof value.id === 'string');
}
function postProgress(title, detail, current, total) {
    postMessage({
        type: 'progress',
        title,
        detail,
        current,
        total,
    });
}
function postMessage(message) {
    figma.ui.postMessage(message);
}
