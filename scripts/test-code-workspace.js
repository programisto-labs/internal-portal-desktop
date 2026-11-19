'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { splitRelative, isSensitiveFile } = require('../src/code-workspace/paths');
const {
  createGitRunner,
  parseStatus,
  parseRemoteUrl,
  buildRemoteLinks,
  isValidBranchName,
  isValidCloneUrl,
  cloneFolderName,
} = require('../src/code-workspace/git');
const { createProjectStore } = require('../src/code-workspace/projects');
const { createFileOps } = require('../src/code-workspace/files');
const { createCodeWorkspaceService } = require('../src/code-workspace/service');
const { createCodeAgentOps, changedRegion } = require('../src/code-workspace/agent-ops');
const { createTerminalManager } = require('../src/code-workspace/terminals');
const { classifyChange, createWatcherManager } = require('../src/code-workspace/watcher');
const { mergePath, readLoginPath, nvmBinDirs } = require('../src/code-workspace/login-env');
const { createHostOpsStore, createJournal } = require('../src/host-ops/store');
const { createHostOpsService } = require('../src/host-ops/service');
const { buildConfirmDialog } = require('../src/host-ops/confirm');

const posix = process.platform !== 'win32';
const USER = 'user-1';

function sh(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' },
    encoding: 'utf8',
  });
}

const testEnv = async () => ({
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
});

describe('paths', () => {
  it('normalises relative paths and refuses traversal, absolute paths and .git', () => {
    assert.deepEqual(splitRelative('src//a/./b.ts'), ['src', 'a', 'b.ts']);
    assert.deepEqual(splitRelative(''), []);
    assert.deepEqual(splitRelative('src\\win\\file.ts'), ['src', 'win', 'file.ts']);
    for (const bad of ['../x', 'a/../../b', '.git/config', 'a/.GIT/HEAD', 'C:\\x', '//server/share', 'a\0b']) {
      assert.throws(() => splitRelative(bad), (err) => Boolean(err.code), bad);
    }
    assert.throws(() => splitRelative('', { allowRoot: false }), /requis/);
    // A leading slash is the project root, not the filesystem root.
    assert.deepEqual(splitRelative('/src/a.ts'), ['src', 'a.ts']);
  });

  it('flags secrets and keys as sensitive, not examples', () => {
    for (const f of ['.env', 'apps/api/.env.local', 'id_rsa', 'certs/server.key', 'x/.npmrc', 'credentials.json', 'service-account-prod.json']) {
      assert.equal(isSensitiveFile(f), true, f);
    }
    for (const f of ['.env.example', '.env.sample', 'src/env.ts', 'README.md', 'keyboard.ts']) {
      assert.equal(isSensitiveFile(f), false, f);
    }
  });
});

describe('git parsers', () => {
  it('parses porcelain v2 status with renames, conflicts and untracked files', () => {
    const raw = [
      '# branch.oid abc',
      '# branch.head feat/x',
      '# branch.upstream origin/feat/x',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa aaa src/a file.ts',
      '2 R. N... 100644 100644 100644 bbb bbb R100 src/new.ts',
      'src/old.ts',
      'u UU N... 100644 100644 100644 100644 c1 c2 c3 conflict.ts',
      '? notes.md',
      '',
    ].join('\0');
    const st = parseStatus(raw);
    assert.equal(st.branch.head, 'feat/x');
    assert.equal(st.branch.upstream, 'origin/feat/x');
    assert.equal(st.branch.ahead, 2);
    assert.equal(st.branch.behind, 1);
    assert.deepEqual(
      st.files.map((f) => [f.path, f.staged, f.unstaged, f.untracked, f.conflicted, f.origPath || null]),
      [
        ['src/a file.ts', false, true, false, false, null],
        ['src/new.ts', true, false, false, false, 'src/old.ts'],
        ['conflict.ts', false, true, false, true, null],
        ['notes.md', false, true, true, false, null],
      ]
    );
    assert.equal(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').branch.detached, true);
  });

  it('derives web links from remotes without ever keeping credentials', () => {
    const r = parseRemoteUrl('https://x-access-token:ghp_secret@github.com/acme/app.git');
    assert.deepEqual({ ...r }, { provider: 'github', host: 'github.com', owner: 'acme', repo: 'app', webUrl: 'https://github.com/acme/app' });
    assert.equal(JSON.stringify(r).includes('secret'), false);
    assert.equal(parseRemoteUrl('git@github.com:acme/app.git').webUrl, 'https://github.com/acme/app');
    assert.equal(parseRemoteUrl('ssh://git@github.com/acme/app').repo, 'app');
    assert.equal(parseRemoteUrl('git@gitlab.com:group/sub/proj.git').owner, 'group/sub');
    assert.equal(parseRemoteUrl('https://bitbucket.org/acme/app.git'), null);
    assert.equal(parseRemoteUrl('/srv/repos/app.git'), null);
    const links = buildRemoteLinks(parseRemoteUrl('git@github.com:acme/app.git'), { branch: 'feat/a b', defaultBranch: 'main' });
    assert.equal(links.newPullRequest, 'https://github.com/acme/app/compare/main...feat/a%20b?expand=1');
    assert.equal(links.branch, 'https://github.com/acme/app/tree/feat/a%20b');
    const gl = buildRemoteLinks(parseRemoteUrl('https://gitlab.com/g/p.git'), { branch: 'x', defaultBranch: 'main' });
    assert.match(gl.newPullRequest, /merge_requests\/new\?merge_request%5Bsource_branch%5D=x$/);
  });

  it('validates branch names and clone URLs', () => {
    for (const ok of ['main', 'feat/code-workspace', 'fix-1.2']) assert.equal(isValidBranchName(ok), true, ok);
    for (const bad of ['', '-x', 'a..b', 'a b', 'a~1', 'x.lock', 'a//b', '/a', 'a@{1}', 'a:b']) {
      assert.equal(isValidBranchName(bad), false, bad);
    }
    for (const ok of ['https://github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@host/x/y']) {
      assert.equal(isValidCloneUrl(ok), true, ok);
    }
    for (const bad of ['--upload-pack=touch /tmp/x', '/tmp/repo', 'file:///tmp/repo', 'ext::sh -c x', 'https://a b']) {
      assert.equal(isValidCloneUrl(bad), false, bad);
    }
    assert.equal(cloneFolderName('git@github.com:acme/my-app.git'), 'my-app');
    assert.equal(cloneFolderName('https://github.com/acme/..'), null);
  });

  it('classifies watcher events and merges PATH', () => {
    assert.deepEqual(classifyChange('src/a.ts'), { kind: 'file', path: 'src/a.ts' });
    assert.equal(classifyChange('node_modules/x/index.js').kind, 'ignored');
    assert.equal(classifyChange('.git/index').kind, 'git');
    assert.equal(classifyChange('.git/objects/ab/cd').kind, 'ignored');
    assert.equal(mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin', ':'), '/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('reads PATH from an interactive login shell first, then a plain login shell', async () => {
    const calls = [];
    const fake = (shell, args, _opts, cb) => {
      calls.push(args.slice(0, -2).join(' '));
      if (args[0] === '-i') return cb(new Error('boom'), '');
      cb(null, 'noise __LASCO_PATH__/a:/b__LASCO_PATH__');
    };
    assert.equal(await readLoginPath({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, execFileImpl: fake }), '/a:/b');
    assert.deepEqual(calls, ['-i -l', '-l']);
  });

  it('adds every nvm node bin folder, default alias first', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvm-'));
    for (const v of ['v18.20.0', 'v22.14.0', 'v26.1.0']) fs.mkdirSync(path.join(root, '.nvm/versions/node', v, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, '.nvm/alias'), { recursive: true });
    fs.writeFileSync(path.join(root, '.nvm/alias/default'), '22\n');
    const dirs = nvmBinDirs(root).map((d) => path.basename(path.dirname(d)));
    assert.deepEqual(dirs, ['v22.14.0', 'v26.1.0', 'v18.20.0']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the most recently shown projects watched and reports debounced changes', async () => {
    const handles = new Map();
    const watchImpl = (root, _opts, cb) => {
      const handle = { root, cb, closed: false, close() { this.closed = true; }, on() {} };
      handles.set(root, handle);
      return handle;
    };
    const sent = [];
    const wc = { id: 7, isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) };
    const watchers = createWatcherManager({ watchImpl });
    for (let i = 0; i < 6; i += 1) watchers.watch(wc, { id: `p${i}`, root: `/r${i}` });
    watchers.watch(wc, { id: 'p0', root: '/r0' }); // shown again
    watchers.watch(wc, { id: 'p6', root: '/r6' });
    assert.equal(handles.get('/r0').closed, false);
    assert.equal(handles.get('/r1').closed, true);
    handles.get('/r6').cb('change', 'src/a.ts');
    handles.get('/r6').cb('change', 'node_modules/x.js');
    handles.get('/r6').cb('change', '.git/index');
    await new Promise((r) => setTimeout(r, 350));
    assert.deepEqual(sent, [['code-fs-changed', { projectId: 'p6', paths: ['src/a.ts'], overflow: false, git: true }]]);
    watchers.unwatchWebContents(wc);
    assert.equal(handles.get('/r6').closed, true);
  });

  it('describes the changed region of an edit', () => {
    const r = changedRegion('a\nb\nc\nd\n', 'a\nB\nB2\nd\n');
    assert.equal(r.startLine, 2);
    assert.deepEqual(r.removed, ['b', 'c']);
    assert.deepEqual(r.added, ['B', 'B2']);
  });
});

describe('workspace on a real repository', { skip: !posix }, () => {
  let tmp;
  let repo;
  let outside;
  let projects;
  let files;
  let git;
  let service;
  let project;
  let trashed;
  let picks;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codews-')));
    repo = path.join(tmp, 'repo');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(repo);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    sh(repo, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n.env\n');
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=abc\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'init');
    git = createGitRunner({ getEnv: testEnv });
    projects = createProjectStore(path.join(tmp, 'state', 'code-projects.json'));
    trashed = [];
    files = createFileOps({
      git,
      trashItem: async (p) => {
        trashed.push(p);
        fs.rmSync(p, { recursive: true, force: true });
      },
    });
    picks = [];
    service = createCodeWorkspaceService({
      projects,
      files,
      git,
      terminals: { isAvailable: () => false },
      watchers: {},
      getEnv: testEnv,
      pickFolder: async () => picks.shift() || null,
      confirmInitRepository: async () => 'init',
    });
    picks.push(path.join(repo, 'src'));
    const added = await service.invoke('projects.add', { userId: USER });
    assert.equal(added.ok, true, JSON.stringify(added));
    project = added.project;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const call = (method, payload = {}) => service.invoke(method, { userId: USER, projectId: project.id, ...payload });

  it('registers the repository top level, once per user, and only for that user', async () => {
    assert.equal(project.root, repo);
    picks.push(repo);
    const again = await service.invoke('projects.add', { userId: USER });
    assert.equal(again.project.id, project.id);
    assert.equal((await service.invoke('projects.list', { userId: USER })).projects.length, 1);
    assert.equal((await service.invoke('projects.list', { userId: 'user-2' })).projects.length, 0);
    const foreign = await service.invoke('fs.read', { userId: 'user-2', projectId: project.id, path: 'src/a.ts' });
    assert.equal(foreign.error.code, 'project_not_found');
    assert.equal((await service.invoke('projects.add', { userId: USER })).cancelled, true);
    assert.equal((await service.invoke('nope', {})).error.code, 'unsupported_operation');
  });

  it('initialises git in a plain folder when the user accepts', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    picks.push(plain);
    const res = await service.invoke('projects.add', { userId: USER });
    assert.equal(res.ok, true);
    assert.equal(res.project.root, plain);
    assert.equal(fs.existsSync(path.join(plain, '.git')), true);
  });

  it('lists folders with ignored entries, hides .git and reads text', async () => {
    const list = await call('fs.list', { path: '' });
    assert.deepEqual(list.entries.map((e) => e.name), ['src', '.env', '.gitignore']);
    assert.equal(list.entries.find((e) => e.name === '.env').ignored, true);
    const file = await call('fs.read', { path: 'src/a.ts' });
    assert.equal(file.content.startsWith('export const a'), true);
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    assert.equal((await call('fs.read', { path: 'bin.dat' })).binary, true);
    assert.equal((await call('fs.read', { path: '.git/config' })).error.code, 'forbidden_path');
    assert.equal((await call('fs.read', { path: '../outside/secret.txt' })).error.code, 'path_traversal');
  });

  it('never follows a symlink out of the project', async () => {
    fs.symlinkSync(outside, path.join(repo, 'link-out'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'file-out'));
    assert.equal((await call('fs.read', { path: 'link-out/secret.txt' })).error.code, 'outside_project');
    assert.equal((await call('fs.read', { path: 'file-out' })).error.code, 'outside_project');
    assert.equal((await call('fs.write', { path: 'link-out/new.txt', content: 'x' })).error.code, 'outside_project');
    assert.equal((await call('fs.write', { path: 'file-out', content: 'x' })).error.code, 'symlink_rejected');
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
    const list = await call('fs.list', { path: '' });
    assert.equal(list.entries.find((e) => e.name === 'link-out').type, 'external');
  });

  it('writes atomically, creates parents and detects changes on disk', async () => {
    const read = await call('fs.read', { path: 'src/a.ts' });
    const saved = await call('fs.write', { path: 'src/a.ts', content: 'changed\n', expectedMtimeMs: read.mtimeMs });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8'), 'changed\n');
    const stale = await call('fs.write', { path: 'src/a.ts', content: 'other\n', expectedMtimeMs: read.mtimeMs - 5000 });
    assert.equal(stale.error.code, 'changed_on_disk');
    const created = await call('fs.write', { path: 'docs/new/deep.md', content: '# hi\n' });
    assert.equal(created.created, true);
    assert.equal(fs.readFileSync(path.join(repo, 'docs', 'new', 'deep.md'), 'utf8'), '# hi\n');
    assert.equal((await call('fs.createFile', { path: 'src/a.ts' })).error.code, 'destination_exists');
    assert.equal((await call('fs.createFolder', { path: 'src' })).error.code, 'destination_exists');
    assert.equal((await call('fs.createFolder', { path: 'lib/x' })).ok, true);
    assert.equal(fs.statSync(path.join(repo, 'lib', 'x')).isDirectory(), true);
    assert.equal(fs.readdirSync(path.join(repo, 'src')).some((n) => n.includes('lasco-')), false);
  });

  it('renames and trashes inside the project only', async () => {
    assert.equal((await call('fs.rename', { from: 'src/a.ts', to: 'src/b.ts' })).ok, true);
    assert.equal(fs.existsSync(path.join(repo, 'src', 'b.ts')), true);
    assert.equal((await call('fs.rename', { from: 'src', to: 'src/inner' })).error.code, 'invalid_path');
    assert.equal((await call('fs.trash', { path: 'src/b.ts' })).ok, true);
    assert.deepEqual(trashed, [path.join(repo, 'src', 'b.ts')]);
    assert.equal((await call('fs.trash', { path: '' })).error.code, 'invalid_path');
  });

  it('searches and lists files with git', async () => {
    fs.writeFileSync(path.join(repo, 'notes.md'), 'Export later\n');
    const res = await call('fs.search', { query: 'export' });
    assert.deepEqual(res.results.map((r) => `${r.path}:${r.line}`).sort(), ['notes.md:1', 'src/a.ts:1', 'src/a.ts:2']);
    assert.equal((await call('fs.search', { query: 'export', caseSensitive: true })).results.length, 2);
    assert.equal((await call('fs.search', { query: 'nothing-here' })).results.length, 0);
    assert.equal((await call('fs.search', { query: '-e' })).ok, true);
    const quick = await call('fs.quickOpen');
    assert.deepEqual(quick.files.sort(), ['.gitignore', 'notes.md', 'src/a.ts']);
  });

  it('stages, commits, diffs, branches and discards', async () => {
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 3;\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    let st = await call('git.status');
    assert.equal(st.branch.head, 'main');
    assert.deepEqual(st.files.map((f) => f.path).sort(), ['new.txt', 'src/a.ts']);
    const head = await call('git.show', { path: 'src/a.ts' });
    assert.equal(head.content, 'export const a = 1;\nexport const b = 2;\n');
    assert.equal((await call('git.show', { path: 'new.txt' })).missing, true);
    assert.equal((await call('git.stage', { paths: ['src/a.ts'] })).ok, true);
    st = await call('git.status');
    assert.equal(st.files.find((f) => f.path === 'src/a.ts').staged, true);
    assert.equal((await call('git.unstage', { paths: ['src/a.ts'] })).ok, true);
    assert.equal((await call('git.stage', { paths: ['src/a.ts', '../x'] })).error.code, 'path_traversal');
    await call('git.stage', { paths: ['src/a.ts'] });
    const commit = await call('git.commit', { message: 'feat: a = 3\n\nBody with "quotes" and $HOME' });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    assert.match(sh(repo, 'log', '-1', '--format=%B'), /Body with "quotes" and \$HOME/);
    assert.equal((await call('git.commit', { message: '   ' })).error.code, 'invalid_request');
    const branch = await call('git.createBranch', { branch: 'feat/x' });
    assert.equal(branch.ok, true);
    assert.equal((await call('git.createBranch', { branch: '--orphan' })).error.code, 'invalid_branch');
    const branches = await call('git.branches');
    assert.deepEqual(branches.local.map((b) => b.name).sort(), ['feat/x', 'main']);
    assert.equal(branches.local.find((b) => b.current).name, 'feat/x');
    assert.equal((await call('git.switch', { branch: 'main' })).ok, true);
    const log = await call('git.log', { limit: 5 });
    assert.equal(log.commits[0].subject, 'feat: a = 3');
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'oops\n');
    const discarded = await call('git.discard', { paths: ['src/a.ts', 'new.txt'] });
    assert.deepEqual([discarded.restored, discarded.trashed], [1, 1]);
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8'), 'export const a = 3;\n');
    assert.deepEqual(trashed, [path.join(repo, 'new.txt')]);
    const push = await call('git.push');
    assert.equal(push.error.code, 'no_remote');
  });

  it('builds links from origin without exposing the remote URL', async () => {
    sh(repo, 'remote', 'add', 'origin', 'https://user:ghp_abcdefghijklmnop@github.com/acme/app.git');
    const res = await call('git.remote');
    assert.equal(res.remote.provider, 'github');
    assert.equal(res.links.newPullRequest, 'https://github.com/acme/app/pull/new/main');
    assert.equal(JSON.stringify(res).includes('ghp_'), false);
  });

  describe('agent operations', () => {
    let store;
    let journal;
    let hostOps;
    let answers;
    let dialogs;
    let n;

    beforeEach(() => {
      store = createHostOpsStore(path.join(tmp, 'state', 'host-ops.json'));
      journal = createJournal(path.join(tmp, 'state', 'journal.json'));
      store.setEnabled(true);
      store.setCodeEnabled(true);
      answers = [];
      dialogs = [];
      n = 0;
      hostOps = createHostOpsService({
        store,
        journal,
        homeDir: path.join(tmp, 'home'),
        confirm: async (req) => {
          dialogs.push(req);
          const a = answers.shift();
          return typeof a === 'function' ? a(req) : a || 'deny';
        },
        codeAgent: createCodeAgentOps({ projects, files, git, homeDir: path.join(tmp, 'home') }),
      });
    });

    const op = (operation, extra = {}, agentId = 'agent-1') =>
      hostOps.execute({ requestId: `c${++n}`, agentId, userId: USER, agentName: 'Dev', operation, projectId: project.id, ...extra });

    it('is off unless « Projets de code » is enabled, and reports it in the capabilities', async () => {
      store.setCodeEnabled(false);
      assert.equal((await op('code.read', { path: 'src/a.ts' })).error.code, 'code_disabled');
      assert.equal(hostOps.getCapabilities().codeEnabled, false);
      store.setCodeEnabled(true);
      assert.equal(hostOps.getCapabilities().operations.includes('code.edit'), true);
      store.setEnabled(false);
      assert.equal(store.isCodeEnabled(), false);
      assert.equal((await op('code.read', { path: 'src/a.ts' })).error.code, 'disabled');
    });

    it('reads projects, files (with offsets), listings, searches, status and diff without a dialog', async () => {
      const projectsRes = await op('code.projects');
      assert.equal(projectsRes.result.projects[0].branch, 'main');
      const read = await op('code.read', { path: 'src/a.ts', offset: 2, limit: 1 });
      assert.equal(read.ok, true, JSON.stringify(read));
      assert.deepEqual([read.result.content, read.result.startLine, read.result.endLine, read.result.totalLines], ['export const b = 2;', 2, 2, 2]);
      const list = await op('code.list', { path: '' });
      assert.equal(list.result.entries.find((e) => e.name === '.env').sensitive, true);
      assert.equal((await op('code.read', { path: '.env' })).error.code, 'sensitive_file');
      fs.writeFileSync(path.join(repo, '.env'), 'export TOKEN=abc\n');
      const search = await op('code.search', { query: 'export' });
      assert.equal(search.result.results.some((r) => r.path === '.env'), false);
      fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 42;\n');
      const diff = await op('git.diff');
      assert.match(diff.result.diff, /\+export const a = 42;/);
      const status = await op('git.status');
      assert.deepEqual(status.result.files.map((f) => f.path), ['src/a.ts']);
      assert.equal(dialogs.length, 0);
      assert.equal((await op('code.read', { path: 'src/a.ts', projectId: 'p_0000000000000000' })).error.code, 'project_not_found');
      assert.equal((await op('code.read', { path: 'src/a.ts' }, 'agent-2')).ok, true);
      assert.equal(
        (await hostOps.execute({ requestId: 'other-user', agentId: 'agent-1', userId: 'user-2', operation: 'code.read', projectId: project.id, path: 'src/a.ts' })).error.code,
        'project_not_found'
      );
    });

    it('edits after consent, verifies the result and journals it', async () => {
      answers.push('once');
      const res = await op('code.edit', { path: 'src/a.ts', oldString: 'const b = 2', newString: 'const b = 20' });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.verification.ok, true);
      assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\nexport const b = 20;\n');
      assert.equal(dialogs[0].file, 'src/a.ts');
      assert.match(dialogs[0].preview, /- export const b = 2;\n\+ export const b = 20;/);
      const spec = buildConfirmDialog({ ...dialogs[0], agentName: 'Dev' });
      assert.deepEqual(spec.decisions, ['deny', 'once', 'always']);
      assert.equal(journal.list()[0].outcome, 'completed');
    });

    it('refuses ambiguous or missing matches and denied edits', async () => {
      assert.equal((await op('code.edit', { path: 'src/a.ts', oldString: 'export const', newString: 'const' })).error.code, 'multiple_matches');
      assert.equal((await op('code.edit', { path: 'src/a.ts', oldString: 'nope', newString: 'x' })).error.code, 'no_match');
      answers.push('deny');
      const denied = await op('code.edit', { path: 'src/a.ts', oldString: 'export const', newString: 'const', replaceAll: true });
      assert.equal(denied.status, 'denied');
      assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\nexport const b = 2;\n');
      answers.push('once');
      const all = await op('code.edit', { path: 'src/a.ts', oldString: 'export const', newString: 'const', replaceAll: true });
      assert.equal(all.ok, true);
      assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\n');
    });

    it('remembers « always » for this agent and project only, never for sensitive files', async () => {
      answers.push('always');
      assert.equal((await op('code.write', { path: 'src/new.ts', content: 'x\n' })).persistentGrantCreated, true);
      assert.equal((await op('code.write', { path: 'src/new2.ts', content: 'y\n' })).decision, 'grant');
      assert.equal(dialogs.length, 1);
      answers.push('deny');
      assert.equal((await op('code.write', { path: 'src/new3.ts', content: 'z\n' }, 'agent-2')).status, 'denied');
      answers.push('once');
      const env = await op('code.write', { path: '.env', content: 'TOKEN=new\n' });
      assert.equal(env.decision, 'once');
      assert.equal(dialogs[dialogs.length - 1].allowPersistent, false);
      assert.equal(dialogs[dialogs.length - 1].sensitive, true);
      store.revokeAll();
      answers.push('deny');
      assert.equal((await op('code.write', { path: 'src/new4.ts', content: 'w\n' })).status, 'denied');
    });

    it('aborts when the file changes while the dialog is open', async () => {
      answers.push(() => {
        fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n// edited by the user\n');
        return 'once';
      });
      const res = await op('code.edit', { path: 'src/a.ts', oldString: 'const b = 2', newString: 'const b = 3' });
      assert.equal(res.error.code, 'changed_during_confirmation');
      assert.match(fs.readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8'), /edited by the user/);
    });

    it('creates new files without clobbering and never writes in .git', async () => {
      answers.push('once');
      const created = await op('code.write', { path: 'pkg/index.ts', content: 'export {};\n' });
      assert.equal(created.result.created, true);
      assert.equal((await op('code.write', { path: '.git/hooks/pre-commit', content: 'x' })).error.code, 'forbidden_path');
      assert.equal(dialogs.length, 1);
    });
  });
});

describe('terminals', { skip: !posix }, () => {
  let available = false;
  before(() => {
    try {
      require('node-pty');
      available = true;
    } catch (_) {
      available = false;
    }
  });

  it('runs the user shell in the project root, streams output and re-attaches', async (t) => {
    if (!available) {
      t.skip('node-pty not installed');
      return;
    }
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeterm-')));
    const sent = [];
    const wc = { id: 1, isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) };
    const terminals = createTerminalManager({ getEnv: async () => ({ ...process.env, SHELL: '/bin/sh' }) });
    const term = await terminals.create(wc, { project: { id: 'p_1', root: tmp }, cols: 80, rows: 24 });
    terminals.write(wc, term.id, 'pwd; echo lasco-$((40+2))\r');
    const deadline = Date.now() + 5000;
    const output = () => sent.filter(([c]) => c === 'code-terminal-data').map(([, p]) => p.data).join('');
    while (!/lasco-42/.test(output()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(output(), /lasco-42/);
    assert.match(output(), new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(terminals.attach(wc, term.id).data, /lasco-42/);
    assert.equal(terminals.attach(wc, term.id).cols, 80);
    assert.deepEqual(terminals.list(wc, 'p_1').map((s) => s.id), [term.id]);
    const other = { id: 2, isDestroyed: () => false, send: () => {} };
    assert.equal(terminals.write(other, term.id, 'echo nope\r'), false);
    assert.throws(() => terminals.attach(other, term.id));
    assert.equal(terminals.resize(wc, term.id, 120, 40), true);
    assert.equal(terminals.attach(wc, term.id).cols, 120);
    terminals.killForWebContents(wc);
    assert.equal(terminals.size(), 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
