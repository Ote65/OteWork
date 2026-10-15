/**
 * dsh-plus-menu — browser half.
 *
 * The shipped composer's `+` button opens exactly one trigger source:
 * `inputTriggers.toggleSource("command", …)`, the slash-command group. Skills
 * (source `skill`) and MCP tools therefore never appear there, however many
 * are installed.
 *
 * This half does not repaint the composer and does not replace the menu. It
 * decorates the two shipped `/` sources in place, and owns one grouped row
 * list with three levels:
 *
 *   empty query      → one row per category, each drillable, with its count
 *   `skills/…`       → that category only, filtered by what follows the token
 *   `mcp/…`          → MCP tools grouped under their server's heading
 *   `commands/…`     → the shipped command rows
 *   any other text   → a flat search across all three, as sections
 *
 * Drilling writes a namespace token into the draft (`/skills/`), which is the
 * same contract the shipped `@` picker uses to enter a directory: the token
 * stays open at the caret, so the update listener re-tracks it and the menu
 * reopens without an explicit re-open call. Picking a leaf replaces the whole
 * token, so the namespace never survives into a sent message.
 *
 * The stock `skill` group is suppressed: this plugin renders every skill row,
 * and two groups of the same rows is exactly the duplication the hierarchy
 * removes. The rows are still fetched from that source, so its catalog cache,
 * ranking, subagent guard and `/name` insertion semantics all still apply.
 *
 * No `require()` calls: the loader's module table seeds only a handful of
 * platform modules, and this half needs none of them.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plus-menu',
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		/** Locale namespace for this plugin's dictionary. */
		var NS = 'plus-menu';
		/** The host half's read-only MCP route. */
		var HOST_API = '/api/plus-menu/mcp';
		/** Category order used until the host answers with the configured one. */
		var DEFAULT_ORDER = ['skills', 'mcp', 'commands'];
		/** How long one host answer is reused, in milliseconds. */
		var HOST_TTL_MS = 5000;
		/**
		 * Namespace tokens a drill row writes into the draft. Deliberately ASCII
		 * and locale-independent: the token is draft text that has to keep parsing
		 * the same way after the UI language changes.
		 */
		var NS_TOKEN = { skills: 'skills/', mcp: 'mcp/', commands: 'commands/' };
		/** The token the back row writes: a bare trigger, which is the empty query. */
		var BACK_TOKEN = '/';

		var zh = {
			'section.skills': '技能',
			'section.mcp': 'MCP',
			'section.commands': '命令',
			'count.items': '{n} 项',
			'count.mcp': '{servers} 个服务器 · {tools} 个工具',
			'back': '← 返回',
			'back.hint': '全部分类',
			'mcp.empty': '未配置 MCP 服务器',
			'mcp.emptyHint': '在 profile 的 cordis.patch.yml 里添加 @deepseek-ai/dsh-mcp-client',
		};

		var en = {
			'section.skills': 'Skills',
			'section.mcp': 'MCP',
			'section.commands': 'Commands',
			'count.items': '{n} items',
			'count.mcp': '{servers} servers · {tools} tools',
			'back': '← Back',
			'back.hint': 'All categories',
			'mcp.empty': 'No MCP server configured',
			'mcp.emptyHint': 'Add @deepseek-ai/dsh-mcp-client rows to the profile cordis.patch.yml',
		};

		/**
		 * Client plugin body: decorate the shipped `/` sources so the composer's
		 * `+` menu becomes a two-level, filterable catalog of skills, MCP tools
		 * and commands.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'plus-menu: dictionaries');

			var inputTriggers = ctx.inputTriggers !== undefined ? ctx.inputTriggers : ctx.get('inputTriggers');
			if (inputTriggers === undefined || inputTriggers === null) {
				console.error('[plus-menu] inputTriggers service is unavailable; the + menu stays stock');
				return;
			}
			var t = ctx.locale.bind(NS);

			/** Live source handles, filled as the shipped plugins register. */
			var sources = { command: undefined, skill: undefined };
			/** Pre-decoration members, so disposal restores the shipped behaviour. */
			var originals = new Map();
			/** Sources already decorated; decoration must not be applied twice. */
			var decorated = new WeakSet();
			/** Per-session host answers, so a keystroke does not refetch the MCP roster. */
			var hostCache = new Map();

			/**
			 * Read one host answer, cached per session. A failure drops the cache entry
			 * so the next open retries, and resolves undefined so the menu still shows
			 * its other categories.
			 * @param sessionId - the session to scope the MCP roster to.
			 * @returns the parsed answer, or undefined.
			 */
			function loadHost(sessionId) {
				var key = String(sessionId === undefined || sessionId === null ? '' : sessionId);
				var hit = hostCache.get(key);
				if (hit !== undefined && Date.now() - hit.at < HOST_TTL_MS) return hit.promise;
				var promise = fetch(HOST_API + '?session=' + encodeURIComponent(key), { headers: { accept: 'application/json' } })
					.then((response) => (response.ok ? response.json() : Promise.reject(new Error('plus-menu host route answered ' + response.status))))
					.then((data) => (data !== null && typeof data === 'object' && data.ok === true ? data : Promise.reject(new Error('plus-menu host route answered not-ok'))))
					.catch((error) => {
						hostCache.delete(key);
						console.error('[plus-menu] MCP roster lookup failed:', error);
						return undefined;
					});
				hostCache.set(key, { at: Date.now(), promise: promise });
				return promise;
			}

			/**
			 * Call a source hook, folding a throw into an empty answer so one failing
			 * contributor never empties the whole menu.
			 * @param fn - the hook.
			 * @param thisArg - its owner.
			 * @param args - the hook arguments.
			 * @param label - a name for the diagnostic.
			 * @returns the hook answer, or an empty list.
			 */
			function safeCall(fn, thisArg, args, label) {
				if (typeof fn !== 'function') return Promise.resolve([]);
				return Promise.resolve()
					.then(() => fn.apply(thisArg, args))
					.then((value) => (value === undefined || value === null ? [] : value))
					.catch((error) => {
						console.error('[plus-menu] ' + label + ' candidates failed:', error);
						return [];
					});
			}

			/**
			 * The shipped skill rows, asked of the shipped source so its catalog cache,
			 * ranking, subagent guard and user-only marker all still apply.
			 * @param session - the session projection.
			 * @param req - the candidate request, query included.
			 * @returns the rows, each marked for pick routing.
			 */
			function skillRows(session, req) {
				var skill = sources.skill;
				if (skill === undefined) return Promise.resolve([]);
				var saved = originals.get(skill);
				var fn = saved === undefined ? skill.candidates : saved.candidates;
				return safeCall(fn, skill, [session, req], 'skill').then((items) => items.map((item) => Object.assign({
					name: item.name,
					__plus: { kind: 'skill', name: item.name },
				}, item.label === undefined ? {} : { label: item.label },
					item.description === undefined ? {} : { description: item.description },
					item.icon === undefined ? {} : { icon: item.icon })));
			}

			/**
			 * Copy a request with a different query, keeping its abort signal.
			 * @param req - the original request.
			 * @param query - the replacement query.
			 * @returns the derived request.
			 */
			function withQuery(req, query) {
				var next = {};
				if (req !== undefined && req !== null) for (var key in req) next[key] = req[key];
				next.query = query;
				return next;
			}

			/**
			 * Ordered-subsequence match, the same shape the shipped `/` ranker uses:
			 * the query's characters must appear in order, case-insensitively.
			 * @param query - the lowercased query.
			 * @param text - the lowercased haystack.
			 * @returns whether the query is a subsequence of the text.
			 */
			function isSubsequence(query, text) {
				if (query === '') return true;
				var at = 0;
				for (var i = 0; i < text.length && at < query.length; i++) {
					if (text.charCodeAt(i) === query.charCodeAt(at)) at++;
				}
				return at === query.length;
			}

			/**
			 * The MCP tools as menu rows, before filtering. `__server` is kept so the
			 * MCP level can use it as the row's section heading.
			 * @param host - the host answer.
			 * @returns the rows.
			 */
			function mcpToolRows(host) {
				var tools = Array.isArray(host.tools) ? host.tools : [];
				return tools.map((tool) => ({
					name: typeof tool.tool === 'string' && tool.tool !== '' ? tool.tool : String(tool.name),
					description: tool.description === undefined || tool.description === ''
						? String(tool.server)
						: String(tool.server) + ' · ' + String(tool.description),
					__server: String(tool.server),
					__plus: { kind: 'insert', text: String(tool.name) + ' ' },
				}));
			}

			/**
			 * Filter and rank MCP rows against a query, best matches first.
			 * @param rows - the unfiltered rows.
			 * @param query - the raw query.
			 * @returns the rows to show.
			 */
			function rankMcp(rows, query) {
				if (query === '') return rows;
				var needle = query.toLowerCase();
				var prefix = [];
				var loose = [];
				for (var i = 0; i < rows.length; i++) {
					var tool = rows[i].name.toLowerCase();
					if (tool.indexOf(needle) === 0) { prefix.push(rows[i]); continue; }
					if (isSubsequence(needle, tool) || isSubsequence(needle, rows[i].__server.toLowerCase()) || isSubsequence(needle, rows[i].description.toLowerCase())) loose.push(rows[i]);
				}
				return prefix.concat(loose);
			}

			/**
			 * Read the configured category order from a host answer.
			 * @param host - the host answer, or undefined.
			 * @returns the order to render.
			 */
			function orderOf(host) {
				return host !== undefined && Array.isArray(host.sections) && host.sections.length > 0 ? host.sections : DEFAULT_ORDER;
			}

			/**
			 * Match one namespace token at the head of a query.
			 * @param query - the raw query.
			 * @returns the category and its remaining filter text, or undefined.
			 */
			function namespaceOf(query) {
				for (var i = 0; i < DEFAULT_ORDER.length; i++) {
					var name = DEFAULT_ORDER[i];
					var token = NS_TOKEN[name];
					if (query.indexOf(token) === 0) return { name: name, rest: query.slice(token.length) };
				}
				return undefined;
			}

			/**
			 * Stamp one section heading onto every row of a section.
			 * @param items - the section's rows.
			 * @param name - the category name.
			 * @returns the headed rows.
			 */
			function sectioned(items, name) {
				var heading = t('section.' + name);
				return items.map((item) => Object.assign({}, item, { section: heading }));
			}

			/** The row that walks one level back up to the category list. */
			function backRow() {
				return {
					name: t('back'),
					description: t('back.hint'),
					drill: true,
					__plus: { kind: 'drill', text: BACK_TOKEN },
				};
			}

			/** The row that explains an MCP roster nobody configured. */
			function mcpEmptyRow() {
				return { name: t('mcp.empty'), description: t('mcp.emptyHint'), __plus: { kind: 'handled' } };
			}

			/**
			 * Level 0: one drillable row per category, with its count. MCP is omitted
			 * entirely when the host route is unreachable, because a category that
			 * cannot open is worse than a category that is absent.
			 * @param commands - the shipped command rows.
			 * @param skills - the shipped skill rows.
			 * @param host - the host answer, or undefined.
			 * @returns the category rows.
			 */
			function categoryRows(commands, skills, host) {
				var order = orderOf(host);
				var rows = [];
				for (var i = 0; i < order.length; i++) {
					var name = order[i];
					var description;
					if (name === 'skills') description = t('count.items', { n: skills.length });
					else if (name === 'commands') description = t('count.items', { n: commands.length });
					else if (name === 'mcp') {
						if (host === undefined) continue;
						var servers = Array.isArray(host.servers) ? host.servers.length : 0;
						var tools = Array.isArray(host.tools) ? host.tools.length : 0;
						description = servers === 0 ? t('mcp.empty') : t('count.mcp', { servers: servers, tools: tools });
					} else continue;
					rows.push({
						name: t('section.' + name),
						description: description,
						drill: true,
						__plus: { kind: 'drill', text: '/' + NS_TOKEN[name] },
					});
				}
				return rows;
			}

			/**
			 * One category level: its rows, filtered by whatever follows the token.
			 * @param ns - the matched namespace.
			 * @param session - the session projection.
			 * @param req - the candidate request.
			 * @param sessionId - the session id for the host route.
			 * @returns the rows.
			 */
			function categoryLevel(ns, session, req, sessionId) {
				if (ns.name === 'skills') {
					return skillRows(session, withQuery(req, ns.rest)).then((rows) => [backRow()].concat(sectioned(rows, 'skills')));
				}
				if (ns.name === 'commands') {
					var saved = originals.get(sources.command);
					var fn = saved === undefined ? undefined : saved.candidates;
					return safeCall(fn, sources.command, [session, withQuery(req, ns.rest)], 'command')
						.then((rows) => [backRow()].concat(sectioned(rows, 'commands')));
				}
				return loadHost(sessionId).then((host) => {
					if (host === undefined) return [backRow(), mcpEmptyRow()];
					var all = mcpToolRows(host);
					if (all.length === 0) return [backRow(), mcpEmptyRow()];
					// The server name doubles as the section heading: one heading per
					// server is the second level of the MCP directory.
					return [backRow()].concat(rankMcp(all, ns.rest)
						.map((row) => Object.assign({}, row, { section: row.__server })));
				});
			}

			/**
			 * A free-text query: a flat search across every category, grouped into
			 * sections, so typing `/comp` behaves the way it always did.
			 * @param commands - the shipped command rows.
			 * @param skills - the shipped skill rows.
			 * @param host - the host answer, or undefined.
			 * @param query - the raw query.
			 * @returns the rows.
			 */
			function searchRows(commands, skills, host, query) {
				var order = orderOf(host);
				var bySection = {
					skills: skills,
					commands: commands,
					mcp: host === undefined ? [] : rankMcp(mcpToolRows(host), query),
				};
				var rows = [];
				for (var i = 0; i < order.length; i++) {
					var items = bySection[order[i]];
					if (!Array.isArray(items)) continue;
					rows = rows.concat(sectioned(items, order[i]));
				}
				return rows;
			}

			/**
			 * Decorate one shipped source. The `skill` source is remembered and its
			 * group suppressed; the `command` source's hooks are wrapped, because that
			 * is the source the composer's `+` button launches.
			 * @param src - the source being registered.
			 */
			function decorate(src) {
				if (src === null || typeof src !== 'object' || decorated.has(src)) return;
				if (src.trigger !== '/' || (src.name !== 'command' && src.name !== 'skill')) return;
				decorated.add(src);
				originals.set(src, { candidates: src.candidates, onPick: src.onPick, showGroupTitle: src.showGroupTitle });

				if (src.name === 'skill') {
					sources.skill = src;
					// Suppressed, not removed: the shipped group would render the same
					// rows this plugin now renders, under a title it cannot localize.
					src.candidates = function () { return Promise.resolve([]); };
					return;
				}

				sources.command = src;
				// The group title would read "Commands" over a skills list; every row
				// this plugin returns carries its own section heading instead.
				src.showGroupTitle = false;

				src.candidates = function (session, req) {
					var sessionId = session === undefined || session === null ? undefined : session.sessionId;
					var query = req === undefined || req === null || typeof req.query !== 'string' ? '' : req.query;

					var ns = namespaceOf(query);
					if (ns !== undefined) return categoryLevel(ns, session, req, sessionId);

					var saved = originals.get(src);
					return Promise.all([
						safeCall(saved === undefined ? undefined : saved.candidates, src, [session, req], 'command'),
						skillRows(session, req),
						loadHost(sessionId),
					]).then((values) => (query === ''
						? categoryRows(values[0], values[1], values[2])
						: searchRows(values[0], values[1], values[2], query)));
				};

				src.onPick = function (pick) {
					var candidate = pick === undefined || pick === null ? undefined : pick.candidate;
					var marker = candidate !== undefined && candidate !== null && typeof candidate === 'object' ? candidate.__plus : undefined;
					if (marker !== undefined && marker !== null) {
						if (marker.kind === 'drill') {
							// An inline drill lands after a word character, where the '/'
							// word-boundary rule keeps the token dead; one leading space
							// restores it so the menu can reopen on the new level.
							var text = marker.text;
							if (pick.position === 'inline' && text.charAt(0) === '/') text = ' ' + text;
							return { text: text, continue: true };
						}
						if (marker.kind === 'skill') return { text: '/' + marker.name + ' ' };
						if (marker.kind === 'insert') return { text: marker.text };
						return 'handled';
					}
					var saved = originals.get(src);
					return saved !== undefined && typeof saved.onPick === 'function' ? saved.onPick.call(src, pick) : 'handled';
				};
			}

			// Sources already registered before this plugin applied.
			var live = inputTriggers.live;
			if (live !== undefined && live !== null && Array.isArray(live.sources)) {
				var existing = live.sources.slice();
				for (var i = 0; i < existing.length; i++) {
					try {
						decorate(existing[i]);
					} catch (error) {
						console.error('[plus-menu] could not decorate an existing source:', error);
					}
				}
			}

			/**
			 * Re-run the open launcher menu against the word the user just typed.
			 *
			 * The `+` button opens a *launcher*: its hit is a synthetic span with no
			 * draft token, and the shipped `track()` deliberately bails out when the
			 * typed text produces no trigger — so the menu stays open and unfiltered.
			 * That is why "click + and start typing" never searched anything.
			 *
			 * This synthesizes the hit the launcher never had: the trailing word
			 * becomes the query, and its span becomes the pick span, so a pick
			 * replaces exactly the text the user typed.
			 *
			 * @param controller - the session's input trigger controller.
			 * @param draft - the current draft text.
			 * @param caret - the caret offset into the draft.
			 * @param draftRev - the input machine's draft revision.
			 */
			function searchLauncher(controller, draft, caret, draftRev) {
				var deps = controller.deps;
				if (deps === undefined || deps === null || deps.roster === undefined || deps.roster === null) return;
				var roster = deps.roster.sources('/');
				if (!Array.isArray(roster) || roster.length === 0) return;

				var start = caret;
				while (start > 0 && !/\s/.test(draft.charAt(start - 1))) start--;
				var word = draft.slice(start, caret);
				var hit = {
					trigger: '/',
					query: word,
					quoted: false,
					position: draft.slice(0, start).trim() === '' ? 'leading' : 'inline',
					span: { start: start, end: caret, draftRev: draftRev },
				};

				controller.stopFetch();
				controller.hit = hit;
				controller.reduce({ type: 'hit', hit });
				controller.refreshHeaders(hit, roster);
				controller.fetchCandidates(hit, roster);
			}

			/** Controllers whose `track` this plugin wraps, and their originals. */
			var controllerOriginals = new Map();

			/**
			 * Wrap one session controller's `track` so typing while the launcher menu
			 * is open filters it. The shipped behaviour is preserved exactly: the
			 * original always runs first, and the extra step only happens on the one
			 * path where it bailed out without producing a hit.
			 * @param controller - the controller to wrap.
			 */
			function patchController(controller) {
				if (controller === null || typeof controller !== 'object' || controllerOriginals.has(controller)) return;
				var original = controller.track;
				if (typeof original !== 'function') return;
				controllerOriginals.set(controller, original);
				controller.track = function (draft, caret, guard, draftRev) {
					var launched = this.launcher !== undefined && this.launcher !== null && this.launcher.getSnapshot() !== null;
					var before = this.hit;
					original.call(this, draft, caret, guard, draftRev);
					if (!launched || this.hit !== before || typeof draft !== 'string') return;
					try {
						searchLauncher(this, draft, caret, draftRev);
					} catch (error) {
						console.error('[plus-menu] launcher search failed:', error);
					}
				};
			}

			/** Wrap every controller that already exists (per-session, created lazily). */
			if (live !== undefined && live !== null && live.controllers !== undefined && live.controllers !== null) {
				try {
					for (const controller of live.controllers.values) patchController(controller);
				} catch (error) {
					console.error('[plus-menu] could not inspect live controllers:', error);
				}
			}

			// Every controller access in the shell goes through `sessionOf`, so wrapping
			// it catches each session's controller as it is first resolved.
			var originalSessionOf = inputTriggers.sessionOf;
			if (typeof originalSessionOf === 'function') {
				inputTriggers.sessionOf = function (actx) {
					var controller = originalSessionOf.call(this, actx);
					try {
						patchController(controller);
					} catch (error) {
						console.error('[plus-menu] could not wrap a session controller:', error);
					}
					return controller;
				};
			}

			// Sources registered later. `registerSource` is the only seam the shipped
			// plugins go through, so wrapping it catches them in any load order.
			var originalRegister = inputTriggers.registerSource;
			if (typeof originalRegister === 'function') {
				inputTriggers.registerSource = function (src) {
					try {
						decorate(src);
					} catch (error) {
						console.error('[plus-menu] could not decorate a registering source:', error);
					}
					return originalRegister.call(this, src);
				};
			}

			ctx.effect(() => () => {
				if (typeof originalRegister === 'function') inputTriggers.registerSource = originalRegister;
				if (typeof originalSessionOf === 'function') inputTriggers.sessionOf = originalSessionOf;
				controllerOriginals.forEach((original, controller) => {
					controller.track = original;
				});
				controllerOriginals.clear();
				originals.forEach((saved, src) => {
					src.candidates = saved.candidates;
					src.onPick = saved.onPick;
					if (saved.showGroupTitle === undefined) delete src.showGroupTitle;
					else src.showGroupTitle = saved.showGroupTitle;
				});
				originals.clear();
				hostCache.clear();
			}, 'plus-menu: restore the shipped sources');
		}

		exports.apply = apply;
		exports.inject = ['inputTriggers', 'locale'];
		return module.exports;
	},
});
