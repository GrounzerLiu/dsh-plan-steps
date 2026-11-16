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

    /** Position of the current step: the first open item. */
    function positionOf(todos) {
      const done = todos.filter((item) => item.status === 'completed').length
      const current = todos.find((item) => item.status === 'in_progress') ?? null
      const total = todos.length
      const index = current === null ? Math.min(done + 1, total) : todos.indexOf(current) + 1
      return { done, total, index, current }
    }

    /** Segmented progress: filled for done, accented for the current step. */
    function Bar({ done, total }) {
      const cells = []
      for (let i = 0; i < total; i += 1) {
        cells.push(
          h('span', {
            key: i,
            style: {
              width: '14px',
              height: '4px',
              borderRadius: '2px',
              background: i < done ? TOKENS.done : i === done ? TOKENS.accent : TOKENS.idle,
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
      const todos = useProjection('todos') ?? []
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
          h('span', { style: { color: TOKENS.secondary, flex: 'none' } }, '☰'),
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
          h(Bar, { done, total }),
          h(
            'span',
            {
              'aria-hidden': true,
              style: {
                color: TOKENS.secondary,
                flex: 'none',
                transform: open ? 'rotate(180deg)' : 'none',
                transition: 'transform 120ms ease',
              },
            },
            '⌄',
          ),
        ),
        open
          ? h(
              'ul',
              {
                style: {
                  listStyle: 'none',
                  margin: 0,
                  padding: '0 12px 8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  maxHeight: '180px',
                  overflowY: 'auto',
                },
              },
              todos.map((todo, i) =>
                h(
                  'li',
                  {
                    key: i,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      fontSize: '13px',
                      lineHeight: '20px',
                      color: todo.status === 'completed' ? TOKENS.done : TOKENS.title,
                    },
                  },
                  h(Glyph, { status: todo.status }),
                  h(
                    'span',
                    {
                      style: {
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    todo.content,
                  ),
                ),
              ),
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
        return h(
          'div',
          { style: { padding: '6px 2px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '10px' } },
          h('span', { style: { whiteSpace: 'nowrap', fontWeight: 600 } }, '计划 · 第 ' + String(position.index) + ' / ' + String(position.total) + ' 步'),
          h(
            'span',
            { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            position.current,
          ),
          h(Bar, { done, total: position.total }),
        )
      } catch (error) {
        return h('div', { style: { padding: '6px 2px', fontSize: '12px', opacity: 0.7 } }, '完成一步')
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        document.documentElement.dataset.taskSteps = 'applied'
        // The shipped panel is a list entry on conversation.input.dock with id
        // 'todo'; claiming the same id at a lower priority replaces it.
        ctx.slots.inject('conversation.input.dock', () => {
          try {
            const dispose = ctx.slots.register(
              { name: 'conversation.input.dock', id: 'todo', order: 0, priority: -1 },
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
