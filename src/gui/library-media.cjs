// Read library annotations without changing the project's saved source or selection.
module.exports = async function libraryMedia(media, endpoint) {
  const token = new URL(endpoint.readerGui).searchParams.get('token');
  const read = async payload => {
    const response = await fetch(endpoint.url + '/command', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
    });
    const reply = await response.json();
    if (!reply.ok) { const error = new Error(reply.error?.message || 'Library unavailable'); error.code = reply.error?.code; throw error; }
    return reply.result;
  };
  const overview = await read({ command: 'overview' });
  const tags = new Map(overview.tags.map(t => [t.id, t.name]));
  const folders = new Map(overview.folders.map(f => [f.id, f.name]));
  const requests = new Map();
  const inspect = id => {
    if (!requests.has(id)) requests.set(id, read({ command: 'inspect', id, relationships: false }).catch(error => {
      if (error.code === 'NOT_FOUND') return null;
      throw error;
    }));
    return requests.get(id);
  };
  const items = {};
  for (const m of media) {
    const link = m.metadata?.library;
    if (!link) continue;
    if (link.libraryId !== overview.libraryId) { items[m.id] = { status: 'Different library' }; continue; }
    const asset = await inspect(link.assetId);
    if (!asset) { items[m.id] = { status: 'Removed from library' }; continue; }
    const range = link.rangeId && !link.temporary ? await inspect(link.rangeId) : null;
    const own = range || asset;
    const status = asset.deleted || asset.purged ? 'Removed from library'
      : asset.sourceId !== link.sourceId ? 'Source changed in library'
      : link.rangeId && !link.temporary && !range ? 'Range removed from library'
      : range && range.revision !== link.rangeRevision ? 'Range changed in library'
      : asset.availability !== 'available' ? 'Library source unavailable' : '';
    items[m.id] = {
      assetRevision: asset.revision, rangeRevision: range?.revision,
      importId: link.rangeId && !link.temporary ? range?.id || link.rangeId : asset.id,
      name: link.temporary || (link.rangeId && !range) ? link.name || asset.name : own.name,
      assetName: asset.name, notes: own.notes || '', parentNotes: range ? asset.notes || '' : '',
      tags: [...new Set([...(asset.tags || []), ...(range?.tags || [])])].map(id => tags.get(id)).filter(Boolean),
      folder: asset.folder === 'inbox' ? 'Inbox' : folders.get(asset.folder) || '',
      takes: asset.takes?.length || 0, status,
    };
  }
  return items;
};
