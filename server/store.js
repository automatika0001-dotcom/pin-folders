// Tiny JSON-file database. Data is small (folders + message snapshots),
// so we keep it all in memory and write it to disk atomically.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'data.json');
    this.data = { folders: [], items: [] };
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run */
    }
    this.data.folders ||= [];
    this.data.items ||= [];
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 150);
  }

  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // ---------- folders ----------
  foldersFor(guildId) {
    return this.data.folders
      .filter((f) => f.guildId === guildId)
      .sort((a, b) => a.position - b.position);
  }

  getFolder(id) {
    return this.data.folders.find((f) => f.id === id) || null;
  }

  findFolderByName(guildId, name) {
    const n = cleanName(name).toLowerCase();
    return this.foldersFor(guildId).find((f) => f.name.toLowerCase() === n) || null;
  }

  createFolder(guildId, name, createdBy = null) {
    const clean = cleanName(name);
    if (!clean) throw new Error('Folder name cannot be empty');
    const existing = this.findFolderByName(guildId, clean);
    if (existing) return existing;
    const list = this.foldersFor(guildId);
    const folder = {
      id: crypto.randomUUID(),
      guildId,
      name: clean,
      position: list.length ? list[list.length - 1].position + 1 : 0,
      createdBy,
      createdAt: Date.now(),
    };
    this.data.folders.push(folder);
    this.save();
    return folder;
  }

  renameFolder(id, name) {
    const f = this.getFolder(id);
    if (!f) throw new Error('Folder not found');
    const clean = cleanName(name);
    if (!clean) throw new Error('Folder name cannot be empty');
    f.name = clean;
    this.save();
    return f;
  }

  deleteFolder(id) {
    const f = this.getFolder(id);
    if (!f) throw new Error('Folder not found');
    this.data.folders = this.data.folders.filter((x) => x.id !== id);
    // Items are never lost: they fall back to "Unsorted".
    for (const it of this.data.items) if (it.folderId === id) it.folderId = null;
    this.save();
  }

  reorderFolders(guildId, orderedIds) {
    const list = this.foldersFor(guildId);
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    list
      .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
      .forEach((f, i) => (f.position = i));
    this.save();
  }

  // ---------- items ----------
  getItem(id) {
    return this.data.items.find((i) => i.id === id) || null;
  }

  findItemByMessage(guildId, messageId) {
    return this.data.items.find((i) => i.guildId === guildId && i.messageId === messageId) || null;
  }

  // Adds a message to a folder, or moves it there if it's already filed.
  upsertItem(snapshot, folderId) {
    const existing = this.findItemByMessage(snapshot.guildId, snapshot.messageId);
    if (existing) {
      Object.assign(existing, snapshot, { id: existing.id, folderId, addedAt: existing.addedAt });
      this.save();
      return existing;
    }
    const item = { ...snapshot, id: crypto.randomUUID(), folderId };
    this.data.items.push(item);
    this.save();
    return item;
  }

  moveItem(id, folderId) {
    const it = this.getItem(id);
    if (!it) throw new Error('Item not found');
    if (folderId) {
      const f = this.getFolder(folderId);
      if (!f || f.guildId !== it.guildId) throw new Error('Folder not found');
    }
    it.folderId = folderId || null;
    this.save();
  }

  removeItem(id) {
    this.data.items = this.data.items.filter((i) => i.id !== id);
    this.save();
  }

  countIn(folderId) {
    return this.data.items.filter((i) => i.folderId === folderId).length;
  }
}

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

module.exports = { Store };
