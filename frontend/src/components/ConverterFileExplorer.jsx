import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { ProgressSpinner } from 'primereact/progressspinner';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Toast } from 'primereact/toast';
import { api } from '../api/client';

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i <= 1 ? 0 : 1)} ${units[i]}`;
}

function mediaTypeBadge(type) {
  if (!type) return null;
  const map = { video: { label: 'Video', severity: 'info' }, audio: { label: 'Audio', severity: 'success' }, iso: { label: 'ISO', severity: 'warning' } };
  const m = map[type] || { label: type, severity: 'secondary' };
  return <Tag value={m.label} severity={m.severity} />;
}

/** Navigiert den Baum per Pfad-String (Ordner UND Dateien) */
function getNodeByPath(root, targetPath) {
  if (!root) return null;
  if ((root.path || '') === (targetPath || '')) return root;
  for (const child of (root.children || [])) {
    if (child.type === 'folder') {
      const found = getNodeByPath(child, targetPath);
      if (found) return found;
    } else if ((child.path || '') === (targetPath || '')) {
      return child;
    }
  }
  return null;
}

/** Kinder des aktuellen Knotens (Ordner zuerst, alphabetisch) */
function listChildren(node) {
  if (!node || !Array.isArray(node.children)) return [];
  return node.children; // buildRawTree liefert bereits sortiert
}

/** Breadcrumb aus Pfad-String */
function buildBreadcrumb(pathStr) {
  if (!pathStr) return [];
  const parts = String(pathStr).split('/').filter(Boolean);
  return parts.map((part, i) => ({ name: part, path: parts.slice(0, i + 1).join('/') }));
}

/** Baum nach Ordnername filtern (nur Ordner in der Seitenleiste) */
function filterTree(node, query) {
  if (!node || node.type !== 'folder') return null;
  if (!query || !query.trim()) return node;
  const q = query.toLowerCase();
  const filteredChildren = (node.children || [])
    .filter((c) => c.type === 'folder')
    .map((c) => filterTree(c, query))
    .filter(Boolean);
  const nameMatches = node.name.toLowerCase().includes(q);
  if (nameMatches || filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }
  return null;
}

/** Alle Datei-Pfade innerhalb eines Knotens rekursiv sammeln */
function collectDescendantFilePaths(node) {
  const result = [];
  for (const child of (node?.children || [])) {
    if (child.type === 'file') result.push(child.path || '');
    else if (child.type === 'folder') result.push(...collectDescendantFilePaths(child));
  }
  return result;
}

/** Zustände, in denen ein Job aktiv läuft → Dateien sind gesperrt */
const LOCKED_JOB_STATES = new Set([
  'ANALYZING', 'RIPPING', 'ENCODING', 'MEDIAINFO_CHECK',
  'CD_ANALYZING', 'CD_RIPPING', 'CD_ENCODING'
]);

/** Datei ist gesperrt wenn ihr Job gerade aktiv läuft */
function isNodeLocked(node) {
  if (!node || node.type !== 'file') return false;
  const jobId = Number(node.jobId);
  if (!Number.isFinite(jobId) || jobId <= 0) return false;
  return LOCKED_JOB_STATES.has(String(node.jobStatus || '').trim().toUpperCase());
}

/** Alle nicht bereits einem Job zugewiesenen und nicht gesperrten Dateipfade sammeln */
function collectDescendantSelectableFilePaths(node) {
  const result = [];
  for (const child of (node?.children || [])) {
    if (child.type === 'file') {
      const assignedJobId = Number(child.jobId);
      if (!Number.isFinite(assignedJobId) || assignedJobId <= 0) {
        result.push(child.path || '');
      }
    } else if (child.type === 'folder') {
      result.push(...collectDescendantSelectableFilePaths(child));
    }
  }
  return result;
}

/** Alle nicht bereits einem Job zugewiesenen und nicht gesperrten Datei-Knoten sammeln */
function collectDescendantSelectableFileNodes(node) {
  const result = [];
  for (const child of (node?.children || [])) {
    if (child.type === 'file') {
      const assignedJobId = Number(child.jobId);
      if (!Number.isFinite(assignedJobId) || assignedJobId <= 0) {
        result.push(child);
      }
    } else if (child.type === 'folder') {
      result.push(...collectDescendantSelectableFileNodes(child));
    }
  }
  return result;
}

/** Nur "Wurzel"-Selektionen: Pfade, die keinen ausgewählten Elternpfad haben */
function getRootSelections(paths) {
  const set = new Set(paths);
  return paths.filter((p) =>
    !paths.some((other) => other !== p && p.startsWith(other + '/') && set.has(other))
  );
}

/** Alle Ordner-Pfade für das Verschieben-Dropdown sammeln */
function collectFolderPaths(node, result = []) {
  if (!node || node.type !== 'folder') return result;
  result.push({ label: node.path ? node.path : '/ (Root)', value: node.path || '' });
  for (const child of (node.children || [])) {
    if (child.type === 'folder') collectFolderPaths(child, result);
  }
  return result;
}

// ── Hauptkomponente ───────────────────────────────────────────────────────────

export default function ConverterFileExplorer({
  onSelectionChange,
  refreshToken,
  selectionResetToken,
  navigateToPath,
  onAssignmentChanged
}) {
  const toastRef = useRef(null);
  const explorerRef = useRef(null);

  // Daten
  const [tree, setTree] = useState(null);
  const [rawDir, setRawDir] = useState(null);
  const [loading, setLoading] = useState(false);

  // Navigation
  const [currentPath, setCurrentPath] = useState('');
  const [expandedFolders, setExpandedFolders] = useState(() => new Set(['']));

  // Auswahl (Checkbox → Job-Zuweisung)
  const [selectedPaths, setSelectedPaths] = useState([]);
  // Aktive Zeilen-Auswahl (Klick → Rename/Delete/Move)
  const [activePaths, setActivePaths] = useState([]);
  const [activeAnchor, setActiveAnchor] = useState(null);

  // Seitenleiste
  const [sidebarQuery, setSidebarQuery] = useState('');

  // Modals
  const [activeModal, setActiveModal] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [renameName, setRenameName] = useState('');
  const [moveTarget, setMoveTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [jobUnassignTarget, setJobUnassignTarget] = useState(null);

  // Stabile Ref für onSelectionChange
  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  const onAssignmentChangedRef = useRef(onAssignmentChanged);
  useEffect(() => { onAssignmentChangedRef.current = onAssignmentChanged; }, [onAssignmentChanged]);

  // ── Baum laden ─────────────────────────────────────────────────────────────

  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.converterGetTree();
      setTree(data.tree || null);
      setRawDir(data.rawDir || null);
    } catch (err) {
      console.error('ConverterFileExplorer: tree load error', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTree(); }, [loadTree, refreshToken]);

  useEffect(() => {
    setSelectedPaths([]);
    setActivePaths([]);
    setActiveAnchor(null);
  }, [selectionResetToken]);

  // Auto-Navigation nach Upload: Baum neu laden, dann in Zielordner navigieren
  // navigateToPath ist { path: string, ts: number } damit jeder Upload einen neuen Trigger auslöst
  useEffect(() => {
    if (!navigateToPath?.path) return;
    loadTree().then(() => {
      navigateTo(navigateToPath.path);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigateToPath]);

  // Auswahl an Eltern melden: Ordner werden zu ihren Datei-Kindern expandiert
  useEffect(() => {
    if (!tree) return;
    setSelectedPaths((prev) => {
      const next = prev.filter((entryPath) => {
        const node = getNodeByPath(tree, entryPath);
        if (!node) return false;
        if (node.type !== 'file') return true;
        const assignedJobId = Number(node.jobId);
        return !Number.isFinite(assignedJobId) || assignedJobId <= 0;
      });
      return next.length === prev.length ? prev : next;
    });

    const rootPaths = getRootSelections(selectedPaths);
    const report = [];
    for (const p of rootPaths) {
      const node = getNodeByPath(tree, p);
      if (!node) continue;
      if (node.type === 'folder') {
        const fileNodes = collectDescendantSelectableFileNodes(node);
        if (fileNodes.length > 0) {
          for (const fn of fileNodes) {
            report.push({
              relPath: fn.path,
              entryType: 'file',
              detectedMediaType: fn.detectedMediaType || null,
              detectedFormat: fn.detectedFormat || null
            });
          }
        } else {
          // Leerer Ordner: als Ordner-Eintrag weitergeben
          report.push({ relPath: node.path, entryType: 'directory', detectedMediaType: null, detectedFormat: null });
        }
      } else {
        report.push({
          relPath: node.path,
          entryType: 'file',
          detectedMediaType: node.detectedMediaType || null,
          detectedFormat: node.detectedFormat || null
        });
      }
    }
    onSelectionChangeRef.current?.(report);
  }, [selectedPaths, tree]);

  // Auswahl bleibt erhalten — kein Outside-Click-Handler

  // ── Navigation ─────────────────────────────────────────────────────────────

  const currentNode = getNodeByPath(tree, currentPath);
  const currentItems = listChildren(currentNode);
  const filteredTree = filterTree(tree, sidebarQuery);
  const topLevelFolders = tree ? (tree.children || []).filter((c) => c.type === 'folder') : [];

  function navigateTo(pathStr) {
    setCurrentPath(pathStr || '');
    setActivePaths([]);
    setActiveAnchor(null);
    setExpandedFolders((prev) => new Set(prev).add(pathStr || ''));
  }

  function handleGoUp() {
    if (!currentPath) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    navigateTo(parts.join('/'));
  }

  function toggleFolder(pathValue) {
    const key = pathValue || '';
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // ── Auswahl ────────────────────────────────────────────────────────────────

  /** Gibt true wenn item.path direkt oder als Kind eines ausgewählten Ordners selektiert ist */
  function isSelected(pathValue) {
    const p = pathValue || '';
    if (selectedPaths.includes(p)) return true;
    return selectedPaths.some((sel) => p.startsWith(sel + '/'));
  }

  /** Unbestimmter Zustand: Ordner, von dem nur Teile selektiert sind */
  function isIndeterminate(item) {
    if (item.type !== 'folder') return false;
    const p = item.path || '';
    if (selectedPaths.includes(p)) return false;
    const folderNode = getNodeByPath(tree, p);
    const allFiles = collectDescendantFilePaths(folderNode);
    return allFiles.length > 0 && allFiles.some((fp) => selectedPaths.includes(fp));
  }

  function handleCheckboxChange(item, checked) {
    const p = item.path || '';

    if (item.type === 'file') {
      // Gesperrte Dateien (Job läuft) → keine Aktion möglich
      if (isNodeLocked(item)) return;

      const assignedJobId = Number(item.jobId);
      const isAssigned = Number.isFinite(assignedJobId) && assignedJobId > 0;
      if (isAssigned && !checked) {
        setJobUnassignTarget({
          relPath: p,
          jobId: Math.trunc(assignedJobId),
          jobTitle: String(item.jobTitle || '').trim() || null
        });
        setActiveModal('job-unassign');
        return;
      }
      if (isAssigned) {
        return;
      }
    }

    if (item.type === 'folder') {
      const folderNode = getNodeByPath(tree, p);
      const descendantFiles = collectDescendantSelectableFilePaths(folderNode);
      if (checked) {
        if (descendantFiles.length === 0) return;
        setSelectedPaths((prev) => Array.from(new Set([...prev, p, ...descendantFiles])));
      } else {
        const toRemove = new Set([p, ...descendantFiles]);
        setSelectedPaths((prev) => prev.filter((x) => !toRemove.has(x)));
      }
    } else {
      const allFilesInCurrentView = currentItems.filter((i) => i.type === 'file').map((i) => i.path || '');
      if (checked) {
        setSelectedPaths((prev) => {
          const next = Array.from(new Set([...prev, p]));
          // Wenn alle Dateien im aktuellen Ordner gewählt → Ordner auch auswählen
          if (currentPath && allFilesInCurrentView.length > 0 &&
              allFilesInCurrentView.every((fp) => next.includes(fp)) &&
              !next.includes(currentPath)) {
            return [...next, currentPath];
          }
          return next;
        });
      } else {
        setSelectedPaths((prev) => {
          const next = prev.filter((x) => x !== p);
          // Ordner abwählen wenn eine seiner Dateien abgewählt wird
          if (currentPath && next.includes(currentPath)) {
            return next.filter((x) => x !== currentPath);
          }
          return next;
        });
      }
    }
  }

  async function handleRemoveFromJob() {
    if (!jobUnassignTarget?.jobId || !jobUnassignTarget?.relPath) return;
    setBusy(true);
    try {
      const result = await api.converterRemoveFileFromJob(jobUnassignTarget.jobId, jobUnassignTarget.relPath);
      const removedRelPath = String(result?.removedRelPath || jobUnassignTarget.relPath || '').trim();
      toastRef.current?.show({
        severity: 'success',
        summary: 'Aus Job entfernt',
        detail: removedRelPath || 'Datei wurde aus dem Job entfernt.',
        life: 2800
      });
      setSelectedPaths((prev) => prev.filter((entryPath) => entryPath !== removedRelPath));
      setJobUnassignTarget(null);
      setActiveModal('');
      await loadTree();
      onAssignmentChangedRef.current?.();
    } catch (err) {
      toastRef.current?.show({
        severity: 'error',
        summary: 'Fehler',
        detail: err.message || 'Datei konnte nicht aus dem Job entfernt werden.',
        life: 4200
      });
    } finally {
      setBusy(false);
    }
  }

  function handleOpen(item) {
    if (item.type !== 'folder') return;
    navigateTo(item.path || '');
  }

  // ── Datei-Operationen ──────────────────────────────────────────────────────

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.converterCreateFolder(currentPath, name);
      toastRef.current?.show({ severity: 'success', summary: 'Ordner erstellt', detail: name, life: 2500 });
      setNewFolderName('');
      setActiveModal('');
      await loadTree();
    } catch (err) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: err.message, life: 4000 });
    } finally { setBusy(false); }
  }

  async function handleRename() {
    if (!activePaths.length) return;
    const name = renameName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.converterRenameFile(activePaths[0], name);
      toastRef.current?.show({ severity: 'success', summary: 'Umbenannt', detail: `→ ${name}`, life: 2500 });
      setRenameName('');
      setActiveModal('');
      setActivePaths([]);
      await loadTree();
    } catch (err) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: err.message, life: 4000 });
    } finally { setBusy(false); }
  }

  async function handleDeleteSelected() {
    if (!activePaths.length) return;
    setBusy(true);
    try {
      for (const p of activePaths) {
        await api.converterDeleteFile(p);
      }
      toastRef.current?.show({ severity: 'success', summary: 'Gelöscht', detail: `${activePaths.length} Eintrag/Einträge`, life: 2500 });
      setActivePaths([]);
      setSelectedPaths((prev) => prev.filter((x) => !activePaths.includes(x)));
      setActiveModal('');
      await loadTree();
    } catch (err) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: err.message, life: 4000 });
    } finally { setBusy(false); }
  }

  async function handleMoveSelected() {
    if (!activePaths.length) return;
    setBusy(true);
    try {
      const isRoot = moveTarget === '' || moveTarget === '__root__';
      await api.converterMoveFile(activePaths[0], isRoot ? '' : moveTarget);
      toastRef.current?.show({ severity: 'success', summary: 'Verschoben', life: 2500 });
      setMoveTarget('');
      setActivePaths([]);
      setActiveModal('');
      await loadTree();
    } catch (err) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: err.message, life: 4000 });
    } finally { setBusy(false); }
  }

  function handleSelectActive() {
    const newPaths = [];
    for (const p of activePaths) {
      const node = getNodeByPath(tree, p);
      if (!node || isNodeLocked(node)) continue;
      if (node.type === 'folder') {
        newPaths.push(p, ...collectDescendantSelectableFilePaths(node));
      } else {
        newPaths.push(p);
      }
    }
    setSelectedPaths((prev) => Array.from(new Set([...prev, ...newPaths])));
  }

  function handleRowClick(e, item) {
    if (isNodeLocked(item)) return;
    const p = item.path || '';
    const items = currentItems;

    if (e.shiftKey && activeAnchor) {
      const anchorIdx = items.findIndex((i) => (i.path || '') === activeAnchor);
      const clickIdx = items.findIndex((i) => (i.path || '') === p);
      if (anchorIdx !== -1 && clickIdx !== -1) {
        const from = Math.min(anchorIdx, clickIdx);
        const to = Math.max(anchorIdx, clickIdx);
        const rangePaths = items.slice(from, to + 1).map((i) => i.path || '');
        if (e.ctrlKey || e.metaKey) {
          setActivePaths((prev) => Array.from(new Set([...prev, ...rangePaths])));
        } else {
          setActivePaths(rangePaths);
        }
      }
    } else if (e.ctrlKey || e.metaKey) {
      setActivePaths((prev) =>
        prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
      );
      setActiveAnchor(p);
    } else {
      setActivePaths([p]);
      setActiveAnchor(p);
    }
  }

  // ── Ordnerbaum (Seitenleiste) ───────────────────────────────────────────────

  function renderFolderTree(node, depth) {
    if (!node || node.type !== 'folder') return null;
    const isActive = (node.path || '') === currentPath;
    const key = node.path || '';
    const isExpanded = expandedFolders.has(key) || depth === 0;
    const childFolders = (node.children || []).filter((c) => c.type === 'folder');
    const hasChildren = childFolders.length > 0;

    const nodeSel = isSelected(key);
    const nodeIndet = isIndeterminate(node);

    return (
      <div key={key || '__root__'} className={`tree-node depth-${depth}`}>
        <div
          className={`tree-row folder${isActive ? ' active' : ''}`}
          onClick={() => handleOpen(node)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') handleOpen(node); }}
        >
          {hasChildren ? (
            <div
              className="tree-caret"
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); toggleFolder(node.path || ''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); toggleFolder(node.path || ''); } }}
            >
              <i className={`pi ${isExpanded ? 'pi-chevron-down' : 'pi-chevron-right'}`} style={{ fontSize: '0.65rem' }} />
            </div>
          ) : (
            <span className="tree-caret disabled" aria-hidden="true" />
          )}
          <span className="tree-checkbox" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={nodeSel}
              ref={(el) => { if (el) el.indeterminate = nodeIndet; }}
              onChange={(e) => handleCheckboxChange(node, e.target.checked)}
              aria-label={`${node.name || 'raw'} auswählen`}
            />
          </span>
          <span className="tree-icon folder">
            <i className="pi pi-folder" />
          </span>
          <span className="tree-label">{node.name || 'raw'}</span>
        </div>
        {isExpanded && hasChildren && childFolders.map((child) => renderFolderTree(child, depth + 1))}
      </div>
    );
  }

  // ── Abgeleitete Werte ──────────────────────────────────────────────────────

  const allFolders = tree ? collectFolderPaths(tree) : [{ label: '/ (Root)', value: '' }];
  const breadcrumb = buildBreadcrumb(currentPath);
  const rootSelected = getRootSelections(selectedPaths);
  // Aktionen basieren auf activePaths (Zeilen-Klick-Auswahl)
  const hasLockedActive = activePaths.some((p) => {
    const node = tree ? getNodeByPath(tree, p) : null;
    return node ? isNodeLocked(node) : false;
  });
  const canRename = activePaths.length === 1 && !hasLockedActive;
  const canDelete = activePaths.length > 0 && !hasLockedActive;
  const canMove = activePaths.length === 1 && !hasLockedActive;
  const canSelectActive = activePaths.length > 1;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="cfx-wrap">
      <Toast ref={toastRef} position="top-right" />

      {/* Obere Leiste: rawdir-Pfad + Aktualisieren */}
      <div className="cfx-top-bar">
        <span className="cfx-rawdir" title={rawDir || ''}>
          {rawDir
            ? <><i className="pi pi-server" style={{ marginRight: 4 }} />{rawDir}</>
            : <em>Kein Ordner konfiguriert</em>}
        </span>
        <Button
          label={loading ? 'Laden …' : 'Aktualisieren'}
          icon={loading ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'}
          size="small"
          outlined
          disabled={loading}
          onClick={loadTree}
        />
      </div>

      {loading && !tree ? (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <ProgressSpinner style={{ width: 32, height: 32 }} />
        </div>
      ) : !rawDir ? (
        <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--rip-muted)', fontSize: '0.85rem' }}>
          Bitte Converter Raw-Ordner in den Settings konfigurieren.
        </div>
      ) : (
        <div className="explorer" ref={explorerRef}>

          {/* Linke Seitenleiste */}
          <div className="explorer-sidebar">
            <div className="explorer-toolbar sidebar-toolbar">
              <InputText
                className="sidebar-search p-inputtext-sm"
                type="search"
                placeholder="Suchen..."
                value={sidebarQuery}
                onChange={(e) => setSidebarQuery(e.target.value)}
                aria-label="Ordner suchen"
              />
            </div>
            <div className="sidebar-tree">
              {topLevelFolders.length === 0 && !sidebarQuery && (
                <div style={{ padding: '0.5rem', fontSize: '0.8rem', color: 'var(--rip-muted)', fontStyle: 'italic' }}>
                  Keine Ordner gefunden.
                </div>
              )}
              {filteredTree && renderFolderTree(filteredTree, 0)}
            </div>
          </div>

          {/* Rechter Hauptbereich */}
          <div className="explorer-main">
            <div className="explorer-toolbar">
              {/* ArrowUp */}
              <button
                type="button"
                className="icon-button"
                onClick={handleGoUp}
                disabled={!currentPath}
                title="Eine Ebene hoch"
                aria-label="Hoch"
              >
                <i className="pi pi-arrow-up" />
              </button>

              {/* Breadcrumb */}
              <div className="explorer-path">
                <span
                  className="breadcrumb-root path-link"
                  onClick={() => navigateTo('')}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigateTo(''); }}
                >
                  raw
                </span>
                {breadcrumb.map((crumb) => (
                  <span
                    key={crumb.path}
                    className="path-link"
                    onClick={() => navigateTo(crumb.path)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') navigateTo(crumb.path); }}
                  >
                    / {crumb.name}
                  </span>
                ))}
              </div>

              {/* Toolbar-Aktionen rechts */}
              <div className="toolbar-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => { setNewFolderName(''); setActiveModal('new-folder'); }}
                  title="Neuer Ordner"
                  aria-label="Neuer Ordner"
                >
                  <i className="pi pi-folder-plus" />
                </button>
                {canSelectActive && (
                  <button
                    type="button"
                    className="icon-button"
                    onClick={handleSelectActive}
                    title="Auswahl als Checkbox setzen"
                    aria-label="Auswahl als Checkbox setzen"
                  >
                    <i className="pi pi-check-square" />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => {
                    const node = getNodeByPath(tree, activePaths[0]);
                    setRenameName(node?.name || '');
                    setActiveModal('rename');
                  }}
                  disabled={!canRename}
                  title="Umbenennen"
                  aria-label="Umbenennen"
                >
                  <i className="pi pi-pencil" />
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  onClick={() => setActiveModal('delete')}
                  disabled={!canDelete}
                  title="Löschen"
                  aria-label="Löschen"
                >
                  <i className="pi pi-trash" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => { setMoveTarget(''); setActiveModal('move'); }}
                  disabled={!canMove}
                  title="Verschieben"
                  aria-label="Verschieben"
                >
                  <i className="pi pi-arrow-right" />
                </button>
              </div>
            </div>

            {/* Dateiliste */}
            <div className="explorer-list">
              {/* Header */}
              <div className="explorer-row header">
                <span />
                <span>Name</span>
                <span>Typ</span>
                <span>Größe</span>
                <span>Job</span>
              </div>

              {/* Zeilen */}
              {currentItems.length === 0 ? (
                <div style={{ padding: '1.5rem', textAlign: 'center', fontSize: '0.82rem', color: 'var(--rip-muted)', fontStyle: 'italic' }}>
                  Leer.
                </div>
              ) : currentItems.map((item) => {
                const assignedJobId = Number(item.jobId);
                const assigned = item.type === 'file' && Number.isFinite(assignedJobId) && assignedJobId > 0;
                const locked = isNodeLocked(item);
                const sel = (assigned || isSelected(item.path)) && !locked;
                const indet = isIndeterminate(item);
                const active = activePaths.includes(item.path || '');
                const jobTitle = String(item.jobTitle || '').trim();
                return (
                  <div
                    key={item.path}
                    className={`explorer-row${sel ? ' selected' : ''}${active ? ' row-active' : ''}${locked ? ' row-locked' : ''}`}
                    onClick={(e) => handleRowClick(e, item)}
                    onDoubleClick={() => item.type === 'folder' && handleOpen(item)}
                    role="row"
                    tabIndex={locked ? -1 : 0}
                    onKeyDown={(e) => { if (locked) return; if (e.key === 'Enter') item.type === 'folder' ? handleOpen(item) : handleCheckboxChange(item, !sel); }}
                  >
                    <span className="row-checkbox">
                      {locked ? (
                        <i className="pi pi-lock" style={{ fontSize: '0.8rem', color: 'var(--rip-muted)' }} title="Datei wird gerade verarbeitet" />
                      ) : (
                        <input
                          type="checkbox"
                          checked={sel}
                          ref={(el) => { if (el) el.indeterminate = indet; }}
                          onChange={(e) => handleCheckboxChange(item, e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`${item.name} auswählen`}
                        />
                      )}
                    </span>
                    <span className="row-name">
                      <span className="row-icon">
                        <i className={`pi ${item.type === 'folder' ? 'pi-folder' : 'pi-file'}`} />
                      </span>
                      {item.name}
                    </span>
                    <span>
                      {item.type === 'folder'
                        ? <Tag value="Ordner" severity="secondary" />
                        : (item.detectedMediaType ? mediaTypeBadge(item.detectedMediaType) : <span style={{ color: 'var(--rip-muted)', fontSize: '0.78rem' }}>Datei</span>)}
                    </span>
                    <span style={{ textAlign: 'right', color: 'var(--rip-muted)', fontSize: '0.78rem' }}>
                      {formatBytes(item.size)}
                    </span>
                    <span className="row-job">
                      {locked ? (
                        <small className="row-job-assignment" style={{ color: 'var(--orange-600, #e65100)' }}
                          title={`Job #${item.jobId} läuft (${item.jobStatus})`}>
                          <i className="pi pi-spin pi-spinner" style={{ fontSize: '0.65rem', marginRight: 3 }} />
                          #{item.jobId} läuft
                        </small>
                      ) : assigned ? (
                        <small
                          className="row-job-assignment"
                          title={jobTitle ? `#${item.jobId} | ${jobTitle}` : `#${item.jobId}`}
                        >
                          #{item.jobId}{jobTitle ? ` | ${jobTitle}` : ''}
                        </small>
                      ) : (
                        <small className="row-job-empty">-</small>
                      )}
                    </span>
                  </div>
                );
              })}

              {/* Footer: Auswahl-Anzahl */}
              {selectedPaths.length > 0 && (
                <div className="explorer-row footer">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span className="footer-count">{getRootSelections(selectedPaths).length} ausgewählt</span>
                </div>
              )}
            </div>
          </div>

          {/* Untere Leiste (ganzeBreite) */}
          <div className="explorer-footer">
            <span>{currentItems.length} Einträge{rawDir ? ` · ${rawDir}` : ''}</span>
          </div>
        </div>
      )}

      {/* ── Dialoge ─────────────────────────────────────────────────────────── */}

      {/* Aus Job entfernen */}
      <Dialog
        header="Aus Job entfernen?"
        visible={activeModal === 'job-unassign'}
        onHide={() => { setActiveModal(''); setJobUnassignTarget(null); }}
        style={{ width: '420px' }}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button
              label="Abbrechen"
              outlined
              onClick={() => { setActiveModal(''); setJobUnassignTarget(null); }}
              disabled={busy}
            />
            <Button
              label="Entfernen"
              severity="danger"
              icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-times'}
              disabled={busy}
              onClick={handleRemoveFromJob}
            />
          </div>
        )}
        modal
      >
        <p style={{ margin: 0, lineHeight: 1.5 }}>
          Soll die Datei aus dem Job&nbsp;
          <strong>
            {jobUnassignTarget?.jobTitle || (jobUnassignTarget?.jobId ? `#${jobUnassignTarget.jobId}` : '-')}
          </strong>
          &nbsp;entfernt werden?
        </p>
      </Dialog>

      {/* Neuer Ordner */}
      <Dialog
        header="Neuen Ordner erstellen"
        visible={activeModal === 'new-folder'}
        onHide={() => { setActiveModal(''); setNewFolderName(''); }}
        style={{ width: '380px' }}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button label="Abbrechen" outlined onClick={() => { setActiveModal(''); setNewFolderName(''); }} disabled={busy} />
            <Button label="Erstellen" icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-check'} disabled={busy || !newFolderName.trim()} onClick={handleCreateFolder} />
          </div>
        }
        modal
      >
        <div className="field">
          <label>Ordnername</label>
          <InputText
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); }}
            autoFocus
            style={{ width: '100%', marginTop: 6 }}
            placeholder={`In: ${currentPath || '/'}`}
          />
        </div>
      </Dialog>

      {/* Umbenennen */}
      <Dialog
        header="Umbenennen"
        visible={activeModal === 'rename'}
        onHide={() => { setActiveModal(''); setRenameName(''); }}
        style={{ width: '380px' }}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button label="Abbrechen" outlined onClick={() => { setActiveModal(''); setRenameName(''); }} disabled={busy} />
            <Button label="Umbenennen" icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-check'} disabled={busy || !renameName.trim()} onClick={handleRename} />
          </div>
        }
        modal
      >
        <div className="field">
          <label>Neuer Name</label>
          <InputText
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
            autoFocus
            style={{ width: '100%', marginTop: 6 }}
          />
        </div>
      </Dialog>

      {/* Löschen */}
      <Dialog
        header="Löschen bestätigen"
        visible={activeModal === 'delete'}
        onHide={() => setActiveModal('')}
        style={{ width: '380px' }}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button label="Abbrechen" outlined onClick={() => setActiveModal('')} disabled={busy} />
            <Button label="Löschen" severity="danger" icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-trash'} disabled={busy} onClick={handleDeleteSelected} />
          </div>
        }
        modal
      >
        <p style={{ margin: 0 }}>
          {rootSelected.length === 1
            ? <><strong>{getNodeByPath(tree, rootSelected[0])?.name}</strong> wirklich löschen?</>
            : <>{rootSelected.length} Einträge wirklich löschen?</>}
        </p>
      </Dialog>

      {/* Verschieben */}
      <Dialog
        header="Verschieben"
        visible={activeModal === 'move'}
        onHide={() => setActiveModal('')}
        style={{ width: '420px' }}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button label="Abbrechen" outlined onClick={() => setActiveModal('')} disabled={busy} />
            <Button label="Verschieben" icon={busy ? 'pi pi-spin pi-spinner' : 'pi pi-check'} disabled={busy} onClick={handleMoveSelected} />
          </div>
        }
        modal
      >
        <div className="field">
          <label>Zielordner</label>
          <Dropdown
            value={moveTarget}
            options={allFolders.filter((f) => {
              const src = rootSelected[0] || '';
              return f.value !== src && !f.value.startsWith(src + '/');
            })}
            onChange={(e) => setMoveTarget(e.value)}
            style={{ width: '100%', marginTop: 6 }}
            placeholder="Zielordner auswählen …"
          />
        </div>
      </Dialog>
    </div>
  );
}
