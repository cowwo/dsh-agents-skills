window.__ModuleLoader__.load({
	id: 'dsh-agents-skills',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const React = require('react');

		// 只用主题 token：深浅色跟随宿主，不写死颜色。
		const S = {
			root: { display: 'flex', flexDirection: 'column', gap: 14, padding: '22px 26px', maxWidth: 980, color: 'var(--dsw-alias-label-primary)' },
			title: { fontSize: 15, fontWeight: 600 },
			path: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all', marginTop: 4 },
			status: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
			editor: { width: '100%', minHeight: 340, boxSizing: 'border-box', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, lineHeight: 1.65, resize: 'vertical' },
			row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
			ghost: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '5px 12px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
			primary: { background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', border: 'none', borderRadius: 8, padding: '5px 16px', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 500 },
			meta: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto' },
			note: { fontSize: 12.5, lineHeight: 1.6 },
			help: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 12 },

			tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2)' },
			tab: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 13.5, padding: '7px 14px', cursor: 'pointer', borderBottom: '2px solid transparent' },
			tabActive: { color: 'var(--dsw-alias-label-primary)', borderBottom: '2px solid var(--dsw-alias-label-primary)', fontWeight: 600 },
			block: { display: 'flex', flexDirection: 'column', gap: 10, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '14px 16px' },
			blockHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
			blockTitle: { fontSize: 13.5, fontWeight: 600 },
			group: { display: 'flex', flexDirection: 'column', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, overflow: 'hidden' },
			groupHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer' },
			groupBody: { display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--dsw-alias-border-l2)' },
			line: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderTop: '1px solid var(--dsw-alias-border-l2)', minWidth: 0 },
			lineWrap: { display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--dsw-alias-border-l2)' },
			name: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, flex: '0 0 auto' },
			desc: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', flex: '1 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			actions: { display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flex: '0 0 auto' },
			badge: { fontSize: 11, borderRadius: 6, padding: '1px 7px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
			badgeOk: { fontSize: 11, borderRadius: 6, padding: '1px 7px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-state-success-primary)', whiteSpace: 'nowrap' },
			badgeWarn: { fontSize: 11, borderRadius: 6, padding: '1px 7px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-state-warn-label)', whiteSpace: 'nowrap' },
			badgeErr: { fontSize: 11, borderRadius: 6, padding: '1px 7px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'nowrap' },
			chevron: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', width: 12, flex: '0 0 auto' },
			mini: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '2px 9px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
			miniPrimary: { border: 'none', borderRadius: 6, padding: '3px 10px', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
			input: { flex: '1 1 240px', minWidth: 0, boxSizing: 'border-box', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
			check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' },
			pre: { margin: '0 12px 10px', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', fontSize: 12, lineHeight: 1.6, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
			dim: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
			notes: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
		};

		/** 失败一律显示人话，不把 Error 对象塞进 state。 */
		function describe(error) {
			if (error === null || error === undefined) return '未知错误';
			return typeof error.message === 'string' ? error.message : String(error);
		}

		/** Remote 响应统一是 { ok, value }，失败是 { ok:false, error }。 */
		function unwrap(response) {
			if (response && response.ok === true) return response.value;
			const failure = response ? response.error : null;
			throw new Error(failure && typeof failure.message === 'string' ? failure.message : '请求失败');
		}

		/** ISO 时间 → 本地时分秒。 */
		function clockText(iso) {
			if (typeof iso !== 'string' || iso.length === 0) return '';
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return '';
			const pad = (value) => (value < 10 ? '0' + String(value) : String(value));
			return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
		}

		/** 日期只显示到天。 */
		function dayText(iso) {
			if (typeof iso !== 'string' || iso.length === 0) return '';
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return '';
			return date.toISOString().slice(0, 10);
		}

		function button(style, onClick, disabled, text) {
			return React.createElement('button', { type: 'button', style: disabled ? { ...style, opacity: 0.45, cursor: 'default' } : style, onClick, disabled }, text);
		}

		function badge(text, style, key) {
			return React.createElement('span', { key, style: style === undefined ? S.badge : style }, text);
		}

		/** 名字排序（同名不会出现在同一个列表里，所以不比较第二键）。 */
		function byName(left, right) {
			return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
		}

		// ── 标签 1：全局 Agent 提示词（原有功能）─────────────────────────────────

		function GlobalAgentPage(props) {
			const rpc = props.rpc;
			const [draft, setDraft] = React.useState('');
			const [state, setState] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState(null);
			const [tick, setTick] = React.useState(0);

			const call = (method, request) => rpc.call('/api', method, { args: { request } }).then(unwrap);

			React.useEffect(() => {
				let alive = true;
				setBusy(true);
				call('globalAgent/read', {}).then((value) => {
					if (!alive) return;
					setState(value);
					setDraft(typeof value.content === 'string' ? value.content : '');
					setNote(null);
					setBusy(false);
				}).catch((error) => {
					if (!alive) return;
					setNote({ kind: 'err', text: '读取失败：' + describe(error) });
					setBusy(false);
				});
				return () => { alive = false; };
			}, [tick]);

			const saved = state !== null && typeof state.content === 'string' ? state.content : '';
			const dirty = state !== null && draft !== saved;
			const bytes = React.useMemo(() => {
				try { return new TextEncoder().encode(draft).length; } catch { return draft.length; }
			}, [draft]);
			const limit = state !== null && typeof state.limitBytes === 'number' ? state.limitBytes : 65536;
			const overBudget = bytes > limit;
			const exists = state !== null && state.exists === true;

			const onSave = () => {
				setBusy(true);
				setNote(null);
				call('globalAgent/write', { content: draft }).then((value) => {
					setState(value);
					setNote({
						kind: 'ok',
						text: (draft.length === 0 ? '已清空' : '已保存') + ' · ' + String(value.bytes) + ' 字节'
							+ (typeof value.backup === 'string' && value.backup.length > 0 ? ' · 旧内容已备份到 ' + value.backup : '')
					});
					setBusy(false);
				}).catch((error) => {
					setNote({ kind: 'err', text: '保存失败：' + describe(error) });
					setBusy(false);
				});
			};

			const onReload = () => setTick(tick + 1);

			const onKeyDown = (event) => {
				if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
					event.preventDefault();
					if (dirty && !busy) onSave();
				}
			};

			return React.createElement('div', { style: S.root },
				React.createElement('div', null,
					React.createElement('div', { style: S.title }, '全局 Agent 提示词'),
					React.createElement('div', { style: S.path }, state === null || typeof state.path !== 'string' ? '读取中…' : state.path),
				),
				React.createElement('div', { style: S.status },
					React.createElement('span', {
						style: { width: 7, height: 7, borderRadius: '50%', flex: 'none', display: 'inline-block', background: exists ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)' }
					}),
					React.createElement('span', null, state === null
						? '读取中…'
						: (exists ? '已存在 · ' + String(state.size) + ' 字节' : '尚未创建 · 保存后自动新建')),
					dirty ? React.createElement('span', null, '· 有未保存修改') : null,
				),
				React.createElement('textarea', {
					style: S.editor,
					value: draft,
					onChange: (event) => { setDraft(event.target.value); setNote(null); },
					onKeyDown,
					spellCheck: false,
					placeholder: '在这里写全局规则，例如：# 全局规则\n- 默认用中文回答。'
				}),
				React.createElement('div', { style: S.row },
					React.createElement('button', {
						type: 'button', style: dirty && !busy ? S.primary : { ...S.primary, opacity: 0.45, cursor: 'default' },
						onClick: onSave, disabled: busy || !dirty
					}, busy ? '处理中…' : '保存'),
					React.createElement('button', { type: 'button', style: S.ghost, onClick: onReload, disabled: busy }, '重新读取'),
					React.createElement('span', { style: S.meta }, String(draft.length) + ' 字符 · ' + String(bytes) + ' 字节 · 上限 ' + String(limit) + ' 字节 · Ctrl/Cmd+S 保存'),
				),
				note === null ? null : React.createElement('div', {
					style: { ...S.note, color: note.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }
				}, note.text),
				overBudget ? React.createElement('div', { style: { ...S.note, color: 'var(--dsw-alias-state-warn-label)' } }, '⚠️ 已超过 ' + String(limit) + ' 字节预算，超出部分可能被丢弃。') : null,
				React.createElement('div', { style: S.help },
					React.createElement('div', null, '这是「全局层」指令：装了 agent-instructions 的预设（本机是 standard / cordis / ptc）会在每个新会话的第一次请求里把它注入给模型，对所有项目生效。'),
					React.createElement('div', null, '保存是整文件替换：覆盖前旧内容会先备份到同目录的 AGENTS.md.bak；保存空内容等于清空规则但文件还在。'),
					React.createElement('div', null, '改动不影响当前会话，从下一个新会话开始生效。'),
				),
			);
		}

		// ── 标签 2：技能（按来源仓库分组的列表）──────────────────────────────────

		/** 「本地·未托管」这一组的固定 key（它没有来源仓库）。 */
		const LOCAL_KEY = '__local__';

		/**
		 * 把「首屏（磁盘 + 锁文件）」与「检查结果（各仓库差异）」拼成一张按仓库的列表。
		 *
		 * 两条规则保证两者不打架：
		 *   1. 已经装上的技能不再显示为「新增」，删掉的也不再挂在「上游已移除」；
		 *   2. 没检查过时（delta 为空）只有已装信息，不编造待办。
		 * @param {object | null} state skillsPanel/overview 的结果
		 * @param {object | null} delta skillsPanel/check 的结果
		 * @returns {object[]} 分组
		 */
		function buildGroups(state, delta) {
			const skills = state === null || !Array.isArray(state.skills) ? [] : state.skills;
			const bySource = new Map();
			const local = [];
			for (const item of skills) {
				if (item.source.length === 0) {
					local.push(item);
					continue;
				}
				const bucket = bySource.get(item.source) ?? [];
				bucket.push(item);
				bySource.set(item.source, bucket);
			}

			const deltaBySource = new Map();
			for (const repo of delta === null || !Array.isArray(delta.repos) ? [] : delta.repos) deltaBySource.set(repo.source, repo);

			const groups = [];
			for (const [source, rows] of bySource) {
				const repo = deltaBySource.get(source);
				const installedNames = new Set(rows.map((item) => item.name));
				const updatable = (repo === undefined ? [] : repo.updatable).filter((item) => installedNames.has(item.name));
				const updatableNames = new Set(updatable.map((item) => item.name));
				const orphans = (repo === undefined ? [] : repo.orphan).filter((item) => installedNames.has(item.name));
				const news = (repo === undefined ? [] : repo.newSkills).filter((item) => !installedNames.has(item.name));
				// 一个技能只能占一行：已装但上游删了的，用「上游已移除」那一行代表它（仍带上已装信息）。
				const orphanNames = new Set(orphans.map((item) => item.name));
				const items = rows
					.filter((item) => !orphanNames.has(item.name))
					.map((item) => ({ kind: updatableNames.has(item.name) ? 'update' : 'installed', name: item.name, row: item }))
					.concat(news.map((item) => ({ kind: 'new', name: item.name, remote: item })))
					.concat(orphans.map((item) => ({ kind: 'orphan', name: item.name, remote: item, row: rows.find((entry) => entry.name === item.name) })))
					.sort(byName);
				groups.push({
					key: source,
					source,
					local: false,
					installed: rows.length,
					available: repo === undefined ? -1 : repo.available,
					checked: repo !== undefined,
					mode: repo === undefined ? '' : repo.mode,
					error: repo === undefined ? '' : repo.error,
					news,
					updatable,
					orphans,
					items,
					pending: news.length + updatable.length + orphans.length,
				});
			}
			if (local.length > 0) {
				groups.push({
					key: LOCAL_KEY,
					source: '',
					local: true,
					installed: local.length,
					available: -1,
					checked: true,
					mode: 'local',
					error: '',
					news: [],
					updatable: [],
					orphans: [],
					items: local.map((item) => ({ kind: 'installed', name: item.name, row: item })).sort(byName),
					pending: 0,
				});
			}

			// 有待办的排前面（待办多的在前），其余按仓库名；「本地·未托管」永远最后。
			groups.sort((left, right) => {
				if (left.local !== right.local) return left.local ? 1 : -1;
				if (right.pending !== left.pending) return right.pending - left.pending;
				return left.source < right.source ? -1 : left.source > right.source ? 1 : 0;
			});
			return groups;
		}

		/**
		 * 「仅显示待办」：只留有新增/可更新/已移除的仓库，组内只留待办行。
		 * @param {object[]} groups buildGroups 的结果
		 * @param {boolean} todoOnly 是否勾选
		 * @returns {object[]} 可见的分组
		 */
		function filterTodo(groups, todoOnly) {
			if (!todoOnly) return groups;
			return groups
				.filter((group) => group.pending > 0)
				.map((group) => ({ ...group, items: group.items.filter((item) => item.kind !== 'installed') }));
		}

		function SkillsPanel(props) {
			const rpc = props.rpc;
			const call = (method, request) => rpc.call('/api', method, { args: { request } }).then(unwrap);

			const [state, setState] = React.useState(null);
			const [note, setNote] = React.useState(null);
			const [busy, setBusy] = React.useState('');
			const [delta, setDelta] = React.useState(null);
			const [checkedAt, setCheckedAt] = React.useState('');
			const [query, setQuery] = React.useState('');
			const [results, setResults] = React.useState(null);
			const [open, setOpen] = React.useState({});
			const [expanded, setExpanded] = React.useState({});
			const [todoOnly, setTodoOnly] = React.useState(false);
			const [tick, setTick] = React.useState(0);

			React.useEffect(() => {
				let alive = true;
				setBusy('load');
				call('skillsPanel/overview', {}).then((value) => {
					if (!alive) return;
					setState(value);
					// 独立页的挂载路径由宿主半上报：没挂上（非 Web 宿主 / 注册冲突）就是空串，
					// 外壳据此决定要不要显示入口链接。
					if (typeof props.onPagePath === 'function') {
						props.onPagePath(typeof value.pagePath === 'string' ? value.pagePath : '');
					}
					setBusy('');
				}).catch((error) => {
					if (!alive) return;
					setNote({ kind: 'err', text: '读取技能失败：' + describe(error) });
					setBusy('');
				});
				return () => { alive = false; };
			}, [tick]);

			const reload = () => setTick(tick + 1);

			/**
			 * 动作成功后把检查结果里对应的条目摘掉，避免页面自相矛盾
			 * （刚装上的还标「新增」、刚删掉的还挂在「上游已移除」）。
			 * @param {string} kind install / remove / update
			 * @param {string} source install 时的仓库
			 * @param {string[]} names 受影响的技能名
			 */
			const prune = (kind, source, names) => {
				const set = new Set(names);
				setDelta((current) => {
					if (current === null) return current;
					const repos = current.repos.map((repo) => {
						if (kind === 'install') {
							if (repo.source !== source) return repo;
							return { ...repo, newSkills: repo.newSkills.filter((item) => !set.has(item.name)) };
						}
						if (kind === 'update') return { ...repo, updatable: repo.updatable.filter((item) => !set.has(item.name)) };
						return {
							...repo,
							updatable: repo.updatable.filter((item) => !set.has(item.name)),
							orphan: repo.orphan.filter((item) => !set.has(item.name)),
						};
					});
					return { ...current, repos };
				});
			};

			/** 统一跑一个动作，结束后刷新首屏。 */
			const runAction = (key, request, doneText, pruneNames) => {
				setBusy(key);
				setNote(null);
				return call('skillsPanel/action', request).then((value) => {
					if (value.ok && Array.isArray(pruneNames) && pruneNames.length > 0) prune(request.kind, request.source, pruneNames);
					setNote({
						kind: value.ok ? 'ok' : 'err',
						text: (doneText === undefined ? '' : doneText + '：') + (value.summary.length > 0 ? value.summary : (value.ok ? '完成' : '失败'))
							+ (value.durationMs > 0 ? ' · 用时 ' + (value.durationMs / 1000).toFixed(1) + ' 秒' : '')
							+ (value.error.length > 0 ? ' · ' + value.error : '')
					});
					setBusy('');
					reload();
				}).catch((error) => {
					setNote({ kind: 'err', text: '执行失败：' + describe(error) });
					setBusy('');
				});
			};

			const onCheck = (sources) => {
				const wanted = Array.isArray(sources) ? sources : [];
				setBusy('check:' + wanted.join(','));
				setNote(null);
				call('skillsPanel/check', { sources: wanted }).then((value) => {
					setDelta((current) => {
						if (wanted.length === 0 || current === null) return value;
						// 单仓库重查：只替换那一行，其它仓库的结果保持不动。
						const merged = current.repos.filter((repo) => !wanted.includes(repo.source)).concat(value.repos);
						return { ...current, ...value, repos: merged };
					});
					setCheckedAt(clockText(value.checkedAt));
					const failed = value.repos.filter((repo) => repo.mode === 'failed').length;
					setNote(failed > 0
						? { kind: 'err', text: String(failed) + ' 个仓库没查到（原因见各仓库行）' + (value.rateLimitText.length > 0 ? ' · ' + value.rateLimitText : '') }
						: { kind: 'ok', text: '已检查 ' + String(value.repos.length) + ' 个来源仓库' + (value.rateLimitText.length > 0 ? ' · ' + value.rateLimitText : '') });
					setBusy('');
				}).catch((error) => {
					setNote({ kind: 'err', text: '检查失败：' + describe(error) });
					setBusy('');
				});
			};

			const onSearch = () => {
				setBusy('search');
				setNote(null);
				call('skillsPanel/search', { query }).then((value) => {
					setResults(value);
					setNote(value.ok ? null : { kind: 'err', text: value.error.length > 0 ? value.error : value.note });
					setBusy('');
				}).catch((error) => {
					setNote({ kind: 'err', text: '搜索失败：' + describe(error) });
					setBusy('');
				});
			};

			const onPreview = (key, request) => {
				if (open[key] !== undefined) {
					setOpen({ ...open, [key]: undefined });
					return;
				}
				setOpen({ ...open, [key]: { loading: true, content: '', error: '' } });
				call('skillsPanel/read', request).then((value) => {
					setOpen((current) => ({ ...current, [key]: { loading: false, content: value.content, error: '' } }));
				}).catch((error) => {
					setOpen((current) => ({ ...current, [key]: { loading: false, content: '', error: describe(error) } }));
				});
			};

			const onRemove = (name) => {
				if (typeof window !== 'undefined' && typeof window.confirm === 'function'
					&& !window.confirm('删除技能 ' + name + '？会从 ' + (state === null ? '~/.agents/skills' : state.root) + ' 移除，并同步 npx skills 的记账。')) return;
				runAction('remove:' + name, { kind: 'remove', source: '', name, skills: [] }, '删除 ' + name, [name]);
			};

			const onUpdate = (name) => runAction('update:' + name, { kind: 'update', source: '', name, skills: [] }, '更新 ' + name, [name]);

			const onInstall = (source, names) => {
				if (names.length === 0) return;
				runAction('install:' + source, { kind: 'install', source, name: '', skills: names }, '安装到 ' + (state === null ? '~/.agents/skills' : state.root), names);
			};

			const groups = buildGroups(state, delta);
			const visible = filterTodo(groups, todoOnly);
			const allExpanded = visible.length > 0 && visible.every((group) => expanded[group.key] === true);
			const toggleAll = () => {
				if (allExpanded) {
					setExpanded({});
					return;
				}
				const next = {};
				for (const group of visible) next[group.key] = true;
				setExpanded(next);
			};
			const toggleGroup = (key) => setExpanded({ ...expanded, [key]: expanded[key] !== true });

			const skills = state === null || !Array.isArray(state.skills) ? [] : state.skills;
			const managed = skills.filter((item) => item.managed);
			const totals = groups.reduce((sum, group) => ({
				news: sum.news + group.news.length,
				updatable: sum.updatable + group.updatable.length,
				orphans: sum.orphans + group.orphans.length,
			}), { news: 0, updatable: 0, orphans: 0 });
			const updateAllTargets = delta === null ? managed.map((item) => item.name) : groups.flatMap((group) => group.updatable.map((item) => item.name));
			const repoCount = groups.filter((group) => !group.local).length;
			const root = state === null ? '' : state.root;

			const renderPreview = (key) => {
				const entry = open[key];
				if (entry === undefined) return null;
				if (entry.loading) return React.createElement('div', { style: { ...S.dim, padding: '0 12px 8px' } }, '读取正文…');
				if (entry.error.length > 0) return React.createElement('div', { style: { ...S.note, color: 'var(--dsw-alias-state-error-primary)', padding: '0 12px 8px' } }, entry.error);
				return React.createElement('pre', { style: S.pre }, entry.content);
			};

			/** 一行技能。状态决定徽章与按钮，行内只有单技能操作。 */
			const renderItem = (group, item) => {
				const key = group.key + '|' + item.kind + '|' + item.name;
				const row = item.row;
				const remote = item.remote;
				const previewKey = 'body:' + key;
				const openable = item.kind === 'new' ? remote.path.length > 0 : item.kind !== 'orphan';
				// 数组子元素必须带 key，否则 React 会在控制台刷警告。
				const badges = [];
				if (item.kind === 'new') badges.push(badge('新增', S.badgeOk, 'new'));
				if (item.kind === 'update') badges.push(badge('可更新', S.badgeWarn, 'update'));
				if (item.kind === 'orphan') badges.push(badge('上游已移除', S.badgeErr, 'orphan'));
				if (row !== undefined && !row.valid) badges.push(badge('格式不合规', S.badgeErr, 'invalid'));
				if (row !== undefined && !row.modelInvocable) badges.push(badge('模型不可见', S.badgeWarn, 'model-off'));
				if (row !== undefined && !row.userInvocable) badges.push(badge('用户不可见', S.badgeWarn, 'user-off'));

				const description = row !== undefined && row.description.length > 0
					? row.description
					: (item.kind === 'new' ? '仓库里有、本地没装' + (remote.path.length > 0 ? ' · ' + remote.path : '') : (item.kind === 'orphan' ? '仓库里已经没有这个技能了' : ''));

				const actions = [];
				if (openable) {
					actions.push(button(S.mini, () => onPreview(previewKey, item.kind === 'new'
						? { name: item.name, source: group.source, path: remote.path }
						: { name: item.name, source: '', path: '' }), false, open[previewKey] === undefined ? '看正文' : '收起'));
				}
				if (item.kind === 'new') actions.push(button(S.miniPrimary, () => onInstall(group.source, [item.name]), busy !== '', '安装'));
				if (item.kind === 'update') actions.push(button(S.miniPrimary, () => onUpdate(item.name), busy !== '', '更新'));
				if (item.kind === 'installed' && row.managed) actions.push(button(S.mini, () => onUpdate(item.name), busy !== '', '更新'));
				if (item.kind !== 'new') actions.push(button(S.mini, () => onRemove(item.name), busy !== '', '删除'));

				return React.createElement('div', { key, style: S.lineWrap },
					React.createElement('div', { style: S.line },
						React.createElement('span', { style: S.name }, item.name),
						badges,
						React.createElement('span', { style: S.desc, title: description }, description),
						row !== undefined && row.installedAt.length > 0 ? React.createElement('span', { style: S.dim }, dayText(row.installedAt)) : null,
						React.createElement('span', { style: S.actions }, actions),
					),
					renderPreview(previewKey),
				);
			};

			/** 一个仓库（或「本地·未托管」）的折叠块。 */
			const renderGroup = (group) => {
				const isOpen = expanded[group.key] === true;
				const head = [];
				head.push(React.createElement('span', { key: 'chevron', style: S.chevron }, isOpen ? '▾' : '▸'));
				head.push(React.createElement('span', { key: 'name', style: S.name }, group.local ? '本地·未托管' : group.source));
				head.push(React.createElement('span', { key: 'installed', style: S.dim }, group.available >= 0
					? '已装 ' + String(group.installed) + '/' + String(group.available)
					: '已装 ' + String(group.installed)));
				if (group.checked) {
					if (group.news.length > 0) head.push(React.createElement('span', { key: 'news' }, badge('新增 ' + String(group.news.length), S.badgeOk)));
					if (group.updatable.length > 0) head.push(React.createElement('span', { key: 'upd' }, badge('可更新 ' + String(group.updatable.length), S.badgeWarn)));
					if (group.orphans.length > 0) head.push(React.createElement('span', { key: 'orphan' }, badge('已移除 ' + String(group.orphans.length), S.badgeErr)));
					if (group.mode === 'cli') head.push(React.createElement('span', { key: 'mode' }, badge('降级模式')));
				} else if (!group.local) {
					head.push(React.createElement('span', { key: 'unchecked' }, badge('未检查')));
				}
				head.push(React.createElement('span', { key: 'actions', style: S.actions },
					group.local ? null : button(S.mini, (event) => { event.stopPropagation(); onCheck([group.source]); }, busy !== '', '重查'),
				));

				return React.createElement('div', { key: group.key, style: S.group },
					React.createElement('div', {
						style: S.groupHead,
						onClick: () => toggleGroup(group.key),
						role: 'button',
						'aria-expanded': isOpen,
					}, head),
					group.error.length > 0 ? React.createElement('div', { style: { ...S.note, color: 'var(--dsw-alias-state-warn-label)', padding: '6px 12px' } }, group.error) : null,
					isOpen ? React.createElement('div', { style: S.groupBody },
						group.items.length === 0 ? React.createElement('div', { style: { ...S.dim, padding: '6px 12px' } }, '这个仓库没有可显示的技能。') : null,
						group.items.map((item) => renderItem(group, item)),
					) : null,
				);
			};

			return React.createElement('div', { style: S.root },
				React.createElement('div', { style: S.row },
					React.createElement('div', null,
						React.createElement('div', { style: S.title }, '技能'),
						React.createElement('div', { style: S.path }, state === null
							? '读取中…'
							: root + ' · ' + String(skills.length) + ' 个技能 · ' + String(repoCount) + ' 个来源仓库'
								+ (delta === null
									? ' · 未检查'
									: ' · 新增 ' + String(totals.news) + ' · 可更新 ' + String(totals.updatable) + ' · 已移除 ' + String(totals.orphans))),
					),
					React.createElement('span', { style: S.meta }, state === null || state.npxPath.length === 0 ? 'npx 不可用' : 'npx 就绪'),
				),
				state === null || state.notes.length === 0 ? null : React.createElement('div', { style: S.notes },
					state.notes.map((text, index) => React.createElement('div', { key: 'note-' + String(index) }, '· ' + text)),
				),
				React.createElement('div', { style: S.row },
					button(S.primary, () => onCheck([]), busy !== '', busy.startsWith('check') ? '检查中…' : '检查更新'),
					button(S.ghost, () => runAction('update:*', { kind: 'update', source: '', name: '', skills: updateAllTargets }, '更新 ' + String(updateAllTargets.length) + ' 个技能', updateAllTargets), busy !== '' || updateAllTargets.length === 0, '全部更新'),
					button(S.ghost, toggleAll, visible.length === 0, allExpanded ? '全部折叠' : '全部展开'),
					React.createElement('label', { style: S.check },
						React.createElement('input', { type: 'checkbox', checked: todoOnly, onChange: (event) => setTodoOnly(event.target.checked) }),
						'仅显示待办',
					),
					React.createElement('span', { style: S.meta }, checkedAt.length > 0 ? '上次检查 ' + checkedAt : '还没检查过'),
				),
				note === null ? null : React.createElement('div', {
					style: { ...S.note, color: note.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }
				}, note.text),

				React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
					visible.length === 0
						? React.createElement('div', { style: S.dim }, todoOnly
							? (delta === null ? '还没检查过，先点「检查更新」。' : '没有待办：所有来源仓库的技能都已装上且是最新的。')
							: (skills.length === 0 ? '这里还没有技能。可以用下面的「搜索安装」，或把技能目录放进 ' + root : '没有可显示的技能。'))
						: null,
					visible.map(renderGroup),
				),

				// 搜索安装（跨仓库，独立一块）
				React.createElement('div', { style: S.block },
					React.createElement('div', { style: S.blockHead },
						React.createElement('span', { style: S.blockTitle }, '搜索安装'),
						React.createElement('input', {
							style: S.input,
							value: query,
							placeholder: '关键词，例如 react / review / changelog',
							onChange: (event) => setQuery(event.target.value),
							onKeyDown: (event) => { if (event.key === 'Enter' && busy === '') onSearch(); }
						}),
						button(S.primary, onSearch, busy !== '' || query.trim().length === 0, busy === 'search' ? '搜索中…' : '搜索'),
					),
					results === null ? React.createElement('div', { style: S.dim }, '走 npx skills find，装的时候用 -a universal，只落到用户级技能目录。') : null,
					results === null ? null : React.createElement('div', null,
						React.createElement('div', { style: S.dim }, results.note + (results.command.length > 0 ? ' · ' + results.command : '')),
						results.results.map((item) => React.createElement('div', { key: 'find:' + item.repo + '@' + item.skill, style: S.line },
							React.createElement('span', { style: S.name }, item.repo + '@' + item.skill),
							badge(item.installs + ' installs'),
							React.createElement('span', { style: S.desc },
								item.url.length > 0 ? React.createElement('a', { href: item.url, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-label-secondary)' } }, item.url) : null,
							),
							React.createElement('span', { style: S.actions },
								button(S.miniPrimary, () => onInstall(item.repo, [item.skill]), busy !== '', '安装'),
							),
						)),
					),
				),

				React.createElement('div', { style: S.help },
					React.createElement('div', null, '列表按来源仓库分组：折叠时看「这个仓库有多少事」，点开是组内的技能。技能就是带 frontmatter 的 Markdown：' + root + '/<名字>/SKILL.md 或平铺 <名字>.md，DSH 只扫这一层，改动由它自带的文件监听热生效——装完不用重启。'),
					React.createElement('div', null, '「新增」= 仓库里有、本地没装；「可更新」= 技能目录的 sha 与 npx skills 记的指纹不一致；「上游已移除」= 你装了但仓库里已经没有了（只提示，不自动删）。'),
					React.createElement('div', null, '装 / 删 / 更新 / 搜索都由 npx skills（skills.sh 生态）执行：安装加 -a universal，只写用户级目录；删除不加 -a，让 CLI 顺手清掉可能存在的软链。'),
					React.createElement('div', null, '本页不做启停、不改技能正文（避免和 npx skills update 的整份覆盖打架），要改请直接编辑文件。'),
				),
			);
		}

		// ── 标签外壳 ────────────────────────────────────────────────────────────

		function AgentsAndSkillsPage(props) {
			const [tab, setTab] = React.useState('agent');
			const [pagePath, setPagePath] = React.useState('');
			const tabButton = (id, text) => React.createElement('button', {
				type: 'button',
				style: tab === id ? { ...S.tab, ...S.tabActive } : S.tab,
				onClick: () => setTab(id)
			}, text);
			return React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
				React.createElement('div', { style: { ...S.tabs, padding: '0 26px' } },
					tabButton('agent', 'Agent'),
					tabButton('skills', 'Skills'),
					// 独立页入口：新标签页打开，走宿主同一道登录校验。
					pagePath.length === 0 ? null : React.createElement('a', {
						href: pagePath,
						target: '_blank',
						rel: 'noreferrer',
						title: '在新标签页打开完整管理页 Agents&Skills（同一个 DSH 登录即可，不用再登一次）',
						style: { marginLeft: 'auto', alignSelf: 'center', fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', padding: '3px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, whiteSpace: 'nowrap' }
					}, 'Agents&Skills ↗'),
				),
				// 两个面板都保持挂载：切回来时编辑器草稿与已展开的正文都还在。
				React.createElement('div', { style: tab === 'agent' ? undefined : { display: 'none' } },
					React.createElement(GlobalAgentPage, { ...props }),
				),
				React.createElement('div', { style: tab === 'skills' ? undefined : { display: 'none' } },
					React.createElement(SkillsPanel, { ...props, onPagePath: setPagePath }),
				),
			);
		}

		const inject = ['slots', 'connection'];

		function apply(ctx) {
			ctx.inject(['slots', 'connection'], (scoped) => {
				const slots = scoped.slots;
				const rpc = scoped.connection.rpc;
				slots.inject('settings.section', () => slots.register({
					name: 'settings.section',
					id: 'global-agent',
					order: 25,
					label: 'Agents&Skills'
				}, (props) => React.createElement(AgentsAndSkillsPage, { ...props, rpc })));
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		// 分组与筛选是这一页的核心逻辑，抽成纯函数导出，供离线冒烟测试直接喂假数据
		// （宿主只读 apply / inject，这两个导出不影响加载）。
		exports.__internals = { buildGroups, filterTodo, byName };
		return module.exports;
	}
});
