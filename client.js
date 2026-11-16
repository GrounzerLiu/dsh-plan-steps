window.__ModuleLoader__.load({
  id: 'dsh-task-steps',
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
        cells.push(
          h('span', {
            key: i,
            style: {
              width: '14px',
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

    function TaskPanel({ useProjection, usePlan }) {
      // The shipped projection keeps only content/status, so a two-level plan
      // loses its level and step ids there. When the plugin's own plan view is
      // wired, read that; otherwise fall back to the shipped projection.
      const fromPlan = usePlan === undefined ? null : usePlan((state) => state)
      const raw = Array.isArray(fromPlan) ? fromPlan : (useProjection('todos') ?? [])
      const todos = raw.map(readItem)
      const [open, setOpen] = React.useState(false)
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
                const color = todo.status === 'completed' ? TOKENS.done : TOKENS.title
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
        const done = position.total - position.open
        const items = Array.from({ length: position.total }, (_, i) => ({
          status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
        }))
        return h(
          'div',
          { style: { padding: '6px 2px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '10px' } },
          h('span', { style: { whiteSpace: 'nowrap', fontWeight: 600 } }, '计划 · 第 ' + String(position.index) + ' / ' + String(position.total) + ' 步'),
          h(
            'span',
            { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            position.current,
          ),
          h(Bar, { items, index: done + 1 }),
        )
      } catch (error) {
        return h('div', { style: { padding: '6px 2px', fontSize: '12px', opacity: 0.7 } }, '完成一步')
      }
    }

    return {
      inject: ['slots', 'uiConversation'],
      apply(ctx) {
        document.documentElement.dataset.taskSteps = 'applied'
        // The shipped panel is a list entry on conversation.input.dock with id
        // 'todo'; claiming the same id at a lower priority replaces it.
        // A plan view over the raw `todo/write` events, so the panel keeps the
        // level and step_id the shipped projection strips.
        try {
          ctx.uiConversation.events.register({
            kind: 'task-steps-plan',
            match: (event) => (event.type === 'todo/write' ? { id: String(event.seq), role: 'start' } : null),
            start: (_context, match) => match.event.data.todos,
            update: (context) => context.state,
            buildViewNode: (context) =>
              context.state === undefined
                ? null
                : { key: context.key, kind: context.kind, id: context.id, target: 'task-steps-plan', data: context.state },
            publication: () => 'none',
          })
          ctx.uiConversation.views.register({
            target: 'task-steps-plan',
            create: () => {
              let state = null
              return {
                empty: null,
                replace: ({ nodes }) => {
                  state = nodes.length === 0 ? null : nodes[nodes.length - 1].data
                  return state
                },
                apply: ({ upserts }) => {
                  if (upserts.length > 0) state = upserts[upserts.length - 1].data
                  return state
                },
              }
            },
          })
        } catch (error) {
          console.warn('[task-steps] plan view unavailable', error)
        }

        ctx.slots.inject('conversation.input.dock', () => {
          try {
            const dispose = ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'todo',
                order: 0,
                priority: -1,
                inject: (sessionId) => ({
                  hooks: { plan: ctx.uiConversation.binding(sessionId).target('task-steps-plan') },
                }),
              },
              TaskPanel,
            )
            document.documentElement.dataset.taskSteps = 'registered'
            return dispose
          } catch (error) {
            document.documentElement.dataset.taskSteps = 'failed: ' + String(error && error.message)
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
