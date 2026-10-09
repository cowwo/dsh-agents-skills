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
			help: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 12 }
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
				overBudget ? React.createElement('div', { style: { ...S.note, color: 'var(--dsw-alias-state-warn-primary)' } }, '⚠️ 已超过 ' + String(limit) + ' 字节预算，超出部分可能被丢弃。') : null,
				React.createElement('div', { style: S.help },
					React.createElement('div', null, '这是「全局层」指令：装了 agent-instructions 的预设（本机是 standard / cordis / ptc）会在每个新会话的第一次请求里把它注入给模型，对所有项目生效。'),
					React.createElement('div', null, '保存是整文件替换：覆盖前旧内容会先备份到同目录的 AGENTS.md.bak；保存空内容等于清空规则但文件还在。'),
					React.createElement('div', null, '改动不影响当前会话，从下一个新会话开始生效。'),
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
				}, (props) => React.createElement(GlobalAgentPage, { ...props, rpc })));
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
