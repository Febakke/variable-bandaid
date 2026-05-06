figma.showUI(__html__, {
  width: 420,
  height: 560,
  themeColors: true,
});

type PluginMessage =
  | { type: 'fix-selection' }
  | { type: 'fix-whole-file' }
  | { type: 'get-mapping-options' }
  | { type: 'apply-variable-mapping'; mappings: VariableMappingRequest[] };

type ProgressMessage = {
  type: 'progress';
  title: string;
  detail: string;
  current?: number;
  total?: number;
};

type ResultMessage = {
  type: 'fix-complete';
  mode: 'selection' | 'whole-file';
  summary: FixSummary;
  issues: FixIssue[];
};

type ErrorMessage = {
  type: 'error';
  message: string;
};

type MappingVariableOption = {
  id: string;
  name: string;
};

type MappingCollectionOption = {
  id: string;
  name: string;
  variables: MappingVariableOption[];
};

type MappingOptionsMessage = {
  type: 'mapping-options';
  collections: MappingCollectionOption[];
};

type MappingCompleteMessage = {
  type: 'mapping-complete';
  summary: {
    mappedVariables: number;
    attempted: number;
    fixed: number;
    failed: number;
  };
  failures: string[];
};

type UiMessage =
  | ProgressMessage
  | ResultMessage
  | ErrorMessage
  | MappingOptionsMessage
  | MappingCompleteMessage;

type ComponentRoot = ComponentNode | ComponentSetNode;
type SelectionRoot = ComponentRoot | FrameNode;
type ScanRootType = ComponentRoot['type'] | FrameNode['type'];
type PaintField = 'fills' | 'strokes';
type IssueReason =
  | 'unresolved-variable'
  | 'collection-mismatch'
  | 'missing-local-match'
  | 'apply-failed';

type LocalVariableLookup = {
  byNameAndCollection: Map<string, Variable>;
  byName: Map<string, Variable[]>;
  localIds: Set<string>;
};

type ComponentContext = {
  componentId: string;
  componentName: string;
  componentType: ScanRootType;
  pageName: string;
  variantName?: string;
};

type FixSummary = {
  componentsScanned: number;
  nodesScanned: number;
  bindingsScanned: number;
  fixed: number;
  alreadyLocal: number;
  skipped: number;
  failed: number;
};

type FixIssue = {
  reason: IssueReason;
  nodeId: string;
  componentName: string;
  componentType: ScanRootType;
  pageName: string;
  variantName?: string;
  nodeName: string;
  nodeType: SceneNode['type'];
  field: string;
  variableId: string;
  variableName?: string;
  collectionName?: string;
  expectedCollectionName?: string;
  matchedCollectionNames?: string[];
  detail: string;
};

type FixContext = {
  lookup: LocalVariableLookup;
  summary: FixSummary;
  issues: FixIssue[];
};

type PaintBinding = {
  field: PaintField;
  index: number;
  variableId: string;
};

type VariableMappingRequest = {
  sourceVariableId: string;
  targetVariableId: string;
};

const MAPPABLE_COLLECTION_NAMES = new Set(['main color', 'semantic', 'support color']);
const variableCache = new Map<string, Variable | null>();
const collectionCache = new Map<string, VariableCollection | null>();
let lastFixIssues: FixIssue[] = [];

figma.ui.onmessage = async (msg: PluginMessage) => {
  try {
    if (msg.type === 'fix-selection') {
      await fixSelection();
      return;
    }

    if (msg.type === 'fix-whole-file') {
      await fixWholeFile();
      return;
    }

    if (msg.type === 'get-mapping-options') {
      await sendMappingOptions();
      return;
    }

    if (msg.type === 'apply-variable-mapping') {
      await applyVariableMapping(msg.mappings);
    }
  } catch (error) {
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
  } else {
    await fixComponentRoot(selectedNode, context);
  }

  const issues = dedupeIssues(context.issues);
  lastFixIssues = context.issues;

  postMessage({
    type: 'fix-complete',
    mode: 'selection',
    summary: context.summary,
    issues,
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
    postProgress(
      'Fixing whole file',
      `Scanning ${getPageName(root)} / ${root.name}`,
      index + 1,
      roots.length,
    );
    await fixComponentRoot(root, context);

    if (index % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  const issues = dedupeIssues(context.issues);
  lastFixIssues = context.issues;

  postMessage({
    type: 'fix-complete',
    mode: 'whole-file',
    summary: context.summary,
    issues,
  });
}

async function sendMappingOptions() {
  const localVariables = await figma.variables.getLocalVariablesAsync('COLOR');
  const collections = new Map<string, MappingCollectionOption>();

  for (const variable of localVariables) {
    const collection = await getCollectionByIdCached(variable.variableCollectionId);
    if (!collection || !MAPPABLE_COLLECTION_NAMES.has(normalizeName(collection.name))) {
      continue;
    }

    const existing = collections.get(collection.id) ?? {
      id: collection.id,
      name: collection.name,
      variables: [],
    };

    existing.variables.push({
      id: variable.id,
      name: variable.name,
    });
    collections.set(collection.id, existing);
  }

  const sortedCollections = Array.from(collections.values())
    .map(collection => ({
      ...collection,
      variables: collection.variables.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  postMessage({
    type: 'mapping-options',
    collections: sortedCollections,
  });
}

async function applyVariableMapping(mappings: VariableMappingRequest[]) {
  postProgress('Mapping variables', 'Applying selected variable mappings...');

  const mappingBySourceId = new Map<string, string>();
  for (const mapping of mappings) {
    if (mapping.sourceVariableId && mapping.targetVariableId) {
      mappingBySourceId.set(mapping.sourceVariableId, mapping.targetVariableId);
    }
  }

  let attempted = 0;
  let fixed = 0;
  const failures: string[] = [];

  console.log('[MAPPING] Starting variable mapping', {
    mappings: mappingBySourceId.size,
    lastFixIssues: lastFixIssues.length,
  });

  for (const issue of lastFixIssues) {
    const targetVariableId = mappingBySourceId.get(issue.variableId);
    if (!targetVariableId) {
      continue;
    }

    attempted++;

    try {
      const targetVariable = await getVariableByIdCached(targetVariableId);
      if (!targetVariable) {
        throw new Error(`Could not resolve target variable ${targetVariableId}.`);
      }

      const node = await figma.getNodeByIdAsync(issue.nodeId);
      if (!node || !isSceneNode(node)) {
        throw new Error(`Could not find node ${issue.nodeName}.`);
      }

      const binding = parsePaintBinding(issue);
      applyPaintBinding(node, binding, targetVariable);
      fixed++;
    } catch (error) {
      failures.push(
        `${issue.componentName} / ${issue.nodeName} / ${issue.field}: ${
          error instanceof Error ? error.message : 'Could not apply mapping.'
        }`,
      );
    }
  }

  console.log('[MAPPING] Variable mapping complete', {
    attempted,
    fixed,
    failed: failures.length,
  });

  postMessage({
    type: 'mapping-complete',
    summary: {
      mappedVariables: mappingBySourceId.size,
      attempted,
      fixed,
      failed: failures.length,
    },
    failures,
  });
}

async function createFixContext(): Promise<FixContext> {
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

async function buildLocalVariableLookup(): Promise<LocalVariableLookup> {
  const localVariables = await figma.variables.getLocalVariablesAsync('COLOR');
  const byNameAndCollection = new Map<string, Variable>();
  const byName = new Map<string, Variable[]>();
  const localIds = new Set<string>();

  for (const variable of localVariables) {
    const collection = await getCollectionByIdCached(variable.variableCollectionId);
    const collectionName = collection?.name ?? '';
    const key = getVariableKey(variable.name, collectionName);

    localIds.add(variable.id);
    if (!byNameAndCollection.has(key)) {
      byNameAndCollection.set(key, variable);
    }

    const nameMatches = byName.get(variable.name) ?? [];
    nameMatches.push(variable);
    byName.set(variable.name, nameMatches);
  }

  return { byNameAndCollection, byName, localIds };
}

function collectComponentRoots(): ComponentRoot[] {
  const roots: ComponentRoot[] = [];

  for (const page of figma.root.children) {
    for (const child of page.children) {
      collectComponentRootsRecursive(child, roots);
    }
  }

  return roots;
}

function collectComponentRootsRecursive(node: SceneNode, roots: ComponentRoot[]) {
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

async function fixComponentRoot(root: ComponentRoot, context: FixContext) {
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

async function fixFrameRoot(root: FrameNode, context: FixContext) {
  context.summary.componentsScanned++;

  await scanNode(
    root,
    context,
    {
      componentId: root.id,
      componentName: root.name,
      componentType: root.type,
      pageName: getPageName(root),
    },
    { skipComponentRoots: true },
  );
}

async function scanNode(
  node: SceneNode,
  context: FixContext,
  componentContext: ComponentContext,
  options: { skipComponentRoots?: boolean } = {},
) {
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

async function fixPaintBindings(
  node: SceneNode,
  context: FixContext,
  componentContext: ComponentContext,
  field: PaintField,
) {
  const bindings = collectPaintBindings(node, field);

  for (const binding of bindings) {
    context.summary.bindingsScanned++;

    const currentVariable = await getVariableByIdCached(binding.variableId);
    if (!currentVariable) {
      context.summary.skipped++;
      context.issues.push({
        reason: 'unresolved-variable',
        ...getIssueBase(componentContext, node, binding),
        detail: `Could not resolve variable reference ${binding.variableId}.`,
      });
      continue;
    }

    if (context.lookup.localIds.has(currentVariable.id)) {
      context.summary.alreadyLocal++;
      continue;
    }

    const currentCollection = await getCollectionByIdCached(currentVariable.variableCollectionId);
    const currentCollectionName = currentCollection?.name ?? '';
    const localVariable = context.lookup.byNameAndCollection.get(
      getVariableKey(currentVariable.name, currentCollectionName),
    );

    if (!localVariable) {
      const sameNameVariables = context.lookup.byName.get(currentVariable.name) ?? [];
      context.summary.skipped++;

      if (sameNameVariables.length > 0) {
        const matchedCollectionNames = await getCollectionNames(sameNameVariables);
        context.issues.push({
          reason: 'collection-mismatch',
          ...getIssueBase(componentContext, node, binding),
          variableName: currentVariable.name,
          collectionName: currentCollectionName,
          expectedCollectionName: currentCollectionName,
          matchedCollectionNames,
          detail: `Found "${currentVariable.name}" locally, but not in collection "${currentCollectionName}".`,
        });
        continue;
      }

      context.issues.push({
        reason: 'missing-local-match',
        ...getIssueBase(componentContext, node, binding),
        variableName: currentVariable.name,
        collectionName: currentCollectionName,
        expectedCollectionName: currentCollectionName,
        detail: `No local color variable named "${currentVariable.name}" in collection "${currentCollectionName}".`,
      });
      continue;
    }

    try {
      applyPaintBinding(node, binding, localVariable);
      context.summary.fixed++;
    } catch (error) {
      context.summary.failed++;
      context.issues.push({
        reason: 'apply-failed',
        ...getIssueBase(componentContext, node, binding),
        variableName: currentVariable.name,
        collectionName: currentCollectionName,
        expectedCollectionName: currentCollectionName,
        detail: error instanceof Error ? error.message : 'Could not apply local variable.',
      });
    }
  }
}

function collectPaintBindings(node: SceneNode, field: PaintField): PaintBinding[] {
  const bindings: PaintBinding[] = [];
  const seen = new Set<string>();
  const boundVariables = 'boundVariables' in node ? node.boundVariables : null;
  const directBindings = boundVariables?.[field];

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

      const paintAlias = paint.boundVariables?.color;
      if (isVariableAlias(paintAlias)) {
        pushPaintBinding(bindings, seen, field, index, paintAlias.id);
      }
    }
  }

  return bindings;
}

function pushPaintBinding(
  bindings: PaintBinding[],
  seen: Set<string>,
  field: PaintField,
  index: number,
  variableId: string,
) {
  const key = `${field}:${index}:${variableId}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  bindings.push({ field, index, variableId });
}

function applyPaintBinding(node: SceneNode, binding: PaintBinding, variable: Variable) {
  const paints = getPaints(node, binding.field);
  if (!Array.isArray(paints)) {
    throw new Error(`Node does not expose ${binding.field}.`);
  }

  const paint = paints[binding.index];
  if (!paint || paint.type !== 'SOLID') {
    throw new Error(`Could not find a solid paint at ${binding.field}[${binding.index}].`);
  }

  const updatedPaints = [...paints];
  updatedPaints[binding.index] = figma.variables.setBoundVariableForPaint(
    paint,
    'color',
    variable,
  );
  setPaints(node, binding.field, updatedPaints);
}

function getPaints(node: SceneNode, field: PaintField): readonly Paint[] | PluginAPI['mixed'] | undefined {
  if (field === 'fills' && 'fills' in node) {
    return node.fills;
  }

  if (field === 'strokes' && 'strokes' in node) {
    return node.strokes;
  }

  return undefined;
}

function setPaints(node: SceneNode, field: PaintField, paints: readonly Paint[]) {
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

async function getVariableByIdCached(id: string): Promise<Variable | null> {
  if (!variableCache.has(id)) {
    variableCache.set(id, await figma.variables.getVariableByIdAsync(id));
  }

  return variableCache.get(id) ?? null;
}

async function getCollectionByIdCached(id: string): Promise<VariableCollection | null> {
  if (!collectionCache.has(id)) {
    collectionCache.set(id, await figma.variables.getVariableCollectionByIdAsync(id));
  }

  return collectionCache.get(id) ?? null;
}

async function getCollectionNames(variables: Variable[]): Promise<string[]> {
  const names: string[] = [];

  for (const variable of variables) {
    const collection = await getCollectionByIdCached(variable.variableCollectionId);
    names.push(collection?.name ?? 'Unknown collection');
  }

  return Array.from(new Set(names));
}

function getIssueBase(
  componentContext: ComponentContext,
  node: SceneNode,
  binding: PaintBinding,
): Omit<FixIssue, 'reason' | 'detail'> {
  return {
    nodeId: node.id,
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

function parsePaintBinding(issue: FixIssue): PaintBinding {
  const match = issue.field.match(/^(fills|strokes)\[(\d+)\]$/);
  if (!match) {
    throw new Error(`Unsupported field ${issue.field}.`);
  }

  return {
    field: match[1] as PaintField,
    index: Number(match[2]),
    variableId: issue.variableId,
  };
}

function dedupeIssues(issues: FixIssue[]): FixIssue[] {
  const deduped: FixIssue[] = [];
  const seen = new Set<string>();

  for (const issue of issues) {
    const key = [
      issue.reason,
      issue.pageName,
      issue.componentName,
      issue.variantName ?? '',
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

function getVariableKey(variableName: string, collectionName: string): string {
  return `${normalizeName(collectionName)}::${normalizeName(variableName)}`;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function getPageName(node: BaseNode): string {
  let current: BaseNode | null = node;

  while (current?.parent) {
    if (current.parent.type === 'PAGE') {
      return current.parent.name;
    }
    current = current.parent;
  }

  return figma.currentPage.name;
}

function isComponentRoot(node: BaseNode): node is ComponentRoot {
  return node.type === 'COMPONENT' || node.type === 'COMPONENT_SET';
}

function isSelectionRoot(node: BaseNode): node is SelectionRoot {
  return isComponentRoot(node) || node.type === 'FRAME';
}

function isSceneNode(node: BaseNode): node is SceneNode {
  return 'type' in node && node.type !== 'PAGE' && node.type !== 'DOCUMENT';
}

function isVariableAlias(value: unknown): value is VariableAlias {
  return (
    typeof value === 'object'
    && value !== null
    && 'type' in value
    && (value as { type: unknown }).type === 'VARIABLE_ALIAS'
    && 'id' in value
    && typeof (value as { id: unknown }).id === 'string'
  );
}

function postProgress(title: string, detail: string, current?: number, total?: number) {
  postMessage({
    type: 'progress',
    title,
    detail,
    current,
    total,
  });
}

function postMessage(message: UiMessage) {
  figma.ui.postMessage(message);
}
