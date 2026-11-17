window.__ModuleLoader__.load({
  id: 'dsh-plan-steps',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TOKENS = {
      title: 'var(--dsw-alias-label-primary, currentColor)',
      secondary: 'var(--dsw-alias-label-tertiary, #8b8f96)',
      accent: 'var(--dsw-alias-state-business-primary, #7c8cff)',
      done: 'var(--dsw-alias-state-success-primary, #2ea043)',
      idle: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      card: 'var(--dsw-specific-menu, transparent)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
      radius: 'var(--dsw-radius-lg, 12px)',
    }

    /**
     * Glass themes (dsh-catppuccin and siblings) expose their look as body
     * variables and mark the document with `data-dsh-glass`; they only blur the
     * surfaces listed in their own seam table, which does not know this panel.
     * Reading the same variables keeps the panel visually identical without
     * patching the theme.
     * @returns extra styles for the panel root, empty when no glass theme is on.
     */
    function glassSurface() {
      if (typeof document === 'undefined' || !document.documentElement.hasAttribute('data-dsh-glass')) return {}
      const blur = 'blur(var(--dsh-glass-blur, 14px))'
      return {
        background: 'var(--dsh-glass-card, var(--dsw-specific-menu, transparent))',
        border: '1px solid var(--dsh-glass-rim-soft, transparent)',
        backdropFilter: blur,
        WebkitBackdropFilter: blur,
        borderRadius: '14px',
      }
    }

    // Material Symbols (google/material-design-icons, Apache-2.0), inlined as
    // path data so the panel renders offline.
    const ICONS = {
      checklist:
        'M222-200 80-342l56-56 85 85 170-170 56 57-225 226Zm0-320L80-662l56-56 85 85 170-170 56 57-225 226Zm298 240v-80h360v80H520Zm0-320v-80h360v80H520Z',
      check:
        'm424-408-86-86q-11-11-28-11t-28 11q-11 11-11 28t11 28l114 114q12 12 28 12t28-12l226-226q11-11 11-28t-11-28q-11-11-28-11t-28 11L424-408Zm56 328q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z',
      chevronDown: 'M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z',
      chevronUp: 'm296-345-56-56 240-240 240 240-56 56-184-184-184 184Z',
    }

    function Icon({ name, size, color }) {
      return h(
        'svg',
        {
          viewBox: '0 -960 960 960',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': true,
          style: { flex: 'none', color, display: 'block' },
        },
        h('path', { d: ICONS[name] }),
      )
    }

    /** A stored item's level and visible text: a sub-step carries ​. */
    function readItem(item) {
      const raw = String(item?.content ?? '')
      const nested = raw.startsWith('​')
      return { ...item, content: nested ? raw.slice(1) : raw, level: nested ? 1 : 0 }
    }

    /** Position of the current step: the first open item. */
    function positionOf(todos) {
      const done = todos.filter((item) => item.status === 'completed').length
      const current = todos.find((item) => item.status === 'in_progress') ?? null
      const total = todos.length
      const index = current === null ? Math.min(done + 1, total) : todos.indexOf(current) + 1
      return { done, total, index, current }
    }

    /**
     * Segmented progress, painted by POSITION rather than by count: a two-level
     * list can hold a pending phase between completed sub-steps, so "done"
     * alone would put the accent on the wrong cell.
     */
    function Bar({ items, index }) {
      const allDone = items.every((item) => item.status === 'completed')
      const cells = []
      for (let i = 0; i < items.length; i += 1) {
        const position = i + 1
        const current = !allDone && position === index
        const filled = items[i].status === 'completed'
        // A phase cell is tall and wide, a sub-step cell short and narrow, so the
        // bar shows the two levels the list already shows.
        const nested = (items[i].level ?? 0) === 1
        cells.push(
          h('span', {
            key: i,
            style: {
              width: nested ? '8px' : '14px',
              height: '4px',
              borderRadius: '2px',
              background: current ? TOKENS.accent : filled ? TOKENS.done : TOKENS.idle,
            },
          }),
        )
      }
      return h('span', { style: { display: 'inline-flex', gap: '3px', alignItems: 'center', flex: 'none' } }, cells)
    }

    function Glyph({ status }) {
      const color = status === 'completed' ? TOKENS.done : status === 'in_progress' ? TOKENS.accent : TOKENS.idle
      return h(
        'span',
        {
          style: {
            width: '16px',
            height: '16px',
            flex: 'none',
            display: 'grid',
            placeItems: 'center',
            color,
            fontSize: '13px',
            lineHeight: 1,
          },
        },
        status === 'completed' ? '✓' : status === 'in_progress' ? '◍' : '○',
      )
    }

    function TaskPanel({ useProjection }) {
      // The shipped projection keeps only content and status, so the level rides
      // inside the content as a zero-width marker and is stripped here.
      const todos = (useProjection('todos') ?? []).map(readItem)
      const [open, setOpen] = React.useState(false)
      // A glass theme can be switched on while the panel is mounted.
      const [glass, setGlass] = React.useState(() => glassSurface())
      React.useEffect(() => {
        const observer = new MutationObserver(() => setGlass(glassSurface()))
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-dsh-glass', 'data-dsh-glass-float'],
        })
        return () => observer.disconnect()
      }, [])
      if (todos.length === 0) return null
      const { done, total, index, current } = positionOf(todos)
      const label = '计划 · 第 ' + String(index) + ' / ' + String(total) + ' 步'
      const headline = current === null ? (done === total ? '全部完成' : '') : current.content
      return h(
        'section',
        {
          'data-testid': 'todo-panel',
          'aria-label': '计划',
          style: {
            width: '100%',
            maxWidth: 'var(--dsh-composer-card-max-width)',
            margin: '0 auto',
            borderRadius: TOKENS.radius,
            background: TOKENS.card,
            color: TOKENS.title,
            fontSize: '13px',
            overflow: 'hidden',
            ...glass,
          },
        },
        h(
          'button',
          {
            type: 'button',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
            style: {
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '6px 12px',
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              font: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
            },
          },
          h('span', { style: { color: TOKENS.secondary, flex: 'none', display: 'grid' } }, h(Icon, { name: 'checklist', size: 18 })),
          h('span', { style: { fontWeight: 500, flex: 'none' } }, label),
          h(
            'span',
            {
              style: {
                flex: 'auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: TOKENS.secondary,
              },
            },
            headline,
          ),
          h(Bar, { items: todos, index }),
          h(
            'span',
            {
              'aria-hidden': true,
              style: { color: TOKENS.secondary, flex: 'none', display: 'grid' },
            },
            h(Icon, { name: open ? 'chevronUp' : 'chevronDown', size: 18 }),
          ),
        ),
        open
          ? h(
              'ul',
              {
                style: {
                  listStyle: 'none',
                  margin: 0,
                  padding: '4px 14px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  maxHeight: '180px',
                  overflowY: 'auto',
                },
              },
              todos.map((todo, i) => {
                const nested = (todo.level ?? 0) === 1
                const color = TOKENS.title
                const index = i + 1
                return h(
                  'li',
                  {
                    key: i,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      fontSize: '13px',
                      lineHeight: '22px',
                      paddingLeft: nested ? '28px' : '0',
                      color,
                      opacity: todo.status === 'completed' ? 0.55 : 1,
                    },
                  },
                  todo.status === 'completed'
                    ? h(Icon, { name: 'check', size: 20, color: TOKENS.done })
                    : h(
                        'svg',
                        {
                          width: 20,
                          height: 20,
                          viewBox: '0 0 20 20',
                          'aria-hidden': true,
                          style: { flex: '0 0 20px', display: 'block' },
                        },
                        h('circle', {
                          cx: 10,
                          cy: 10,
                          r: 9,
                          fill: 'none',
                          stroke: todo.status === 'in_progress' ? TOKENS.accent : TOKENS.idle,
                          strokeWidth: 1,
                        }),
                        h(
                          'text',
                          {
                            x: 10,
                            y: 10,
                            dy: '0.35em',
                            textAnchor: 'middle',
                            fontSize: 10,
                            fill: todo.status === 'in_progress' ? TOKENS.accent : TOKENS.secondary,
                            fontFamily: 'inherit',
                          },
                          String(index),
                        ),
                      ),
                  h(
                    'span',
                    {
                      style: {
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: nested ? 400 : 600,
                      },
                    },
                    todo.content,
                  ),
                )
              }),
            )
          : null,
      )
    }

    /** The sign-off row: position + current step for one complete_step call. */
    function resultText(block) {
      const parts = []
      if (Array.isArray(block?.content)) {
        for (const part of block.content) {
          if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
        }
      }
      if (parts.length === 0 && typeof block?.output === 'string') parts.push(block.output)
      return parts.join('\n')
    }

    function readPosition(text) {
      if (typeof text !== 'string' || text === '') return null
      if (/Every step in the task list is now complete/.test(text)) return { done: true }
      const next = /the next step is (\d+) "([^"]*)"/.exec(text)
      if (next === null) return null
      const index = Number(next[1])
      // Prefer the stated total: in a two-level list the current phase can sit
      // before its own completed sub-steps, so "index - 1 + open" undercounts.
      const stated = /\((\d+) open of (\d+)\)/.exec(text)
      if (stated !== null) {
        const openCount = Number(stated[1])
        return { index, current: next[2], open: openCount, total: Number(stated[2]), done: false }
      }
      const open = /\((\d+) open\)/.exec(text)
      const openCount = open === null ? 0 : Number(open[1])
      return { index, current: next[2], open: openCount, total: index - 1 + openCount, done: false }
    }

    function StepRow({ block }) {
      try {
        const position = readPosition(resultText(block))
        if (position === null) {
          return h('div', { style: { padding: '6px 2px', fontSize: '12px', opacity: 0.75 } }, '完成一步')
        }
        if (position.done === true) {
          return h('div', { style: { padding: '6px 2px', fontSize: '13px', fontWeight: 600 } }, '计划 · 全部完成')
        }
        // No bar here: one linear bar cannot show a two-level list truthfully — a
        // phase can be current while completed sub-steps sit after it — so the row
        // states the position and the panel, which knows every status, draws it.
        return h(
          'div',
          { style: { padding: '6px 2px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '10px' } },
          h('span', { style: { whiteSpace: 'nowrap', fontWeight: 600 } }, '计划 · 第 ' + String(position.index) + ' / ' + String(position.total) + ' 步'),
          h(
            'span',
            { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            position.current,
          ),
        )
      } catch (error) {
        return h('div', { style: { padding: '6px 2px', fontSize: '12px', opacity: 0.7 } }, '完成一步')
      }
    }

    /** The settings card shown on the plugin page. */
    const SETTINGS_NS = 'settings.planSteps'
    const SETTINGS_TEXT = {
      zh: {
        title: '计划步骤',
        guard: '完成必须签核',
        guardHint: '不允许直接改列表把任务标成完成，必须逐项签核',
        hold: '未完成时继续工作',
        holdHint: '一轮要结束时若还有未完成任务，自动拉回来继续（每轮一次）',
        restore: '跨轮保留进度',
        restoreHint: '每轮开始时重建任务面板，否则要等下一次写入才显示',
      },
      en: {
        title: 'Plan steps',
        guard: 'Completions need a sign-off',
        guardHint: 'An item cannot be closed by rewriting the list; sign each one off',
        hold: 'Keep working while items are open',
        holdHint: 'A turn that is about to end with open items is pulled back once',
        restore: 'Keep the panel across turns',
        restoreHint: 'Rebuild the task panel at the start of a turn',
      },
    }

    const SETTINGS_ROWS = [
      ['guardUnsignedCompletions', 'guard', 'guardHint'],
      ['holdOpenList', 'hold', 'holdHint'],
      ['restorePanel', 'restore', 'restoreHint'],
    ]

    /** The three switches, shared by the row page and the bundle section. */
    function Toggles({ value, writable, onToggle, label }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        SETTINGS_ROWS.map(([key, dictKey, hintKey]) => {
          const on = value[key] !== false
          return h(
            'div',
            { key, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
              h('span', { style: { fontSize: '13px' } }, label(dictKey)),
              h(
                'span',
                { style: { fontSize: '12px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #8b8f96)' } },
                label(hintKey),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': on,
                disabled: writable === false,
                onClick: () => onToggle(key, !on),
                style: {
                  width: '36px',
                  height: '20px',
                  flex: 'none',
                  borderRadius: '999px',
                  border: 'none',
                  cursor: writable === false ? 'default' : 'pointer',
                  background: on ? 'var(--dsw-alias-state-business-primary, #4c8dff)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,0.4))',
                  position: 'relative',
                  transition: 'background 120ms ease',
                },
              },
              h('span', {
                style: {
                  position: 'absolute',
                  top: '2px',
                  left: on ? '18px' : '2px',
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  background: '#fff',
                  transition: 'left 120ms ease',
                },
              }),
            ),
          )
        }),
      )
    }

    /** The row's own Configure page; the owner hands it {view, form}. */
    function SettingsCard({ form, view, label }) {
      if (view !== 'page' || form === undefined) return null
      const state = form.state ?? {}
      return h(Toggles, {
        value: state.value ?? {},
        writable: state.writable !== false,
        onToggle: (key, next) => void form.mutate([{ op: 'set', path: [key], value: next }], state.revision),
        label,
      })
    }

    /** The same switches as a section on the bundle's own page. */
    function DetailSection({ form, label }) {
      const snapshot = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
      )
      const value = snapshot?.value ?? {}
      return h(Toggles, {
        value,
        writable: snapshot?.writable !== false,
        onToggle: (key, next) => void form.set(key, next),
        label,
      })
    }

    return {
      inject: ['slots', 'configForms', 'locale'],
      apply(ctx) {
        // The plugin page shows a card a plugin contributes; a Config alone only
        // validates and persists. Register the card while the Host serves this
        // entry, and drive it through the same form the Host projects.
        try {
          const t = ctx.locale === undefined ? (key) => SETTINGS_TEXT.zh[key] : ctx.locale.bind(SETTINGS_NS)
          if (ctx.locale !== undefined) ctx.locale.register(SETTINGS_NS, SETTINGS_TEXT)
          // The row's own page: plugins.row.config is keyed by
          // "<package name>#<row id>" and the owner hands the page its form.
          ctx.effect(
            () =>
              ctx.slots.inject('plugins.row.config', () => {
                document.documentElement.dataset.planCard = 'registered'
                return ctx.slots.register(
                  {
                    name: 'plugins.row.config',
                    key: 'dsh-plan-steps#plan-steps',
                    label: () => t('title'),
                    inject: () => ({ label: (key) => t(key) }),
                  },
                  SettingsCard,
                )
              }),
            'plan-steps: row settings',
          )
          const form = ctx.configForms.get('plan-steps')
          if (form !== undefined && form !== null) {
            ctx.effect(
              () =>
                ctx.slots.inject('plugins.bundle.config', () =>
                  ctx.slots.register(
                    {
                      name: 'plugins.bundle.config',
                      key: 'dsh-plan-steps',
                      inject: () => ({ form, label: (key) => t(key) }),
                    },
                    DetailSection,
                  ),
                ),
              'plan-steps: bundle config',
            )
          }
        } catch (error) {
          document.documentElement.dataset.planCard = 'error: ' + String(error && error.message)
          console.warn('[plan-steps] settings card unavailable', error)
        }

        document.documentElement.dataset.planSteps = 'applied'
        // The shipped panel is a list entry on conversation.input.dock with id
        // 'todo'; claiming the same id at a lower priority replaces it.
        ctx.slots.inject('conversation.input.dock', () => {
          try {
            const dispose = ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'todo',
                order: 0,
                priority: -1,
              },
              TaskPanel,
            )
            document.documentElement.dataset.planSteps = 'registered'
            return dispose
          } catch (error) {
            document.documentElement.dataset.planSteps = 'failed: ' + String(error && error.message)
            return undefined
          }
        })
        ctx.slots.inject('tool.call.toolview', () => {
          try {
            return ctx.slots.register({ name: 'tool.call.toolview', key: 'complete_step' }, StepRow)
          } catch (error) {
            return undefined
          }
        })
      },
    }
  },
})
