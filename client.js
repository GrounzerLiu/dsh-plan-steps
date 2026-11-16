window.__ModuleLoader__.load({
  id: 'dsh-task-steps',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Read the task list out of a todo_write call without trusting its shape. */
    function readTodos(block) {
      const raw = block && typeof block.bodyRaw === 'string' ? block.bodyRaw : null
      if (raw === null) return null
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return null
      }
      if (!parsed || !Array.isArray(parsed.todos)) return null
      const items = []
      for (const todo of parsed.todos) {
        if (!todo || typeof todo.content !== 'string') continue
        items.push({ content: todo.content, status: todo.status || 'pending' })
      }
      return items.length === 0 ? null : items
    }

    function Progress({ done, total, current }) {
      const cells = []
      for (let i = 0; i < total; i += 1) {
        const filled = i < done
        const active = !filled && i === done && current
        cells.push(
          h('span', {
            key: i,
            style: {
              width: '14px',
              height: '5px',
              borderRadius: '3px',
              background: filled
                ? 'var(--dsw-alias-text-secondary, #9aa0a6)'
                : active
                  ? 'var(--dsw-alias-brand-primary, #7c8cff)'
                  : 'var(--dsw-alias-border-subtle, rgba(127,127,127,0.25))',
            },
          }),
        )
      }
      return h('span', { style: { display: 'inline-flex', gap: '3px', alignItems: 'center' } }, cells)
    }

    function Row(props) {
      try {
        return renderRow(props)
      } catch (error) {
        return h('div', { style: { padding: '6px 2px', fontSize: '12px', opacity: 0.7 } }, 'Task steps')
      }
    }

    function renderRow({ block }) {
      const todos = readTodos(block)
      const [open, setOpen] = React.useState(false)
      if (todos === null) {
        return h('div', { style: { padding: '6px 2px', fontSize: '12px', opacity: 0.7 } }, 'Task steps')
      }
      const done = todos.filter((todo) => todo.status === 'completed').length
      const current = todos.find((todo) => todo.status === 'in_progress')
      const step = current ? todos.indexOf(current) + 1 : Math.min(done + 1, todos.length)
      const label = '计划 · 第 ' + String(step) + ' / ' + String(todos.length) + ' 步'
      return h(
        'div',
        { style: { padding: '6px 2px', fontSize: '13px' } },
        h(
          'div',
          {
            role: 'button',
            tabIndex: 0,
            onClick: () => setOpen(!open),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setOpen(!open)
              }
            },
            style: { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' },
          },
          h(
            'span',
            { style: { whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--dsw-alias-text-primary, inherit)' } },
            label,
          ),
          h(
            'span',
            {
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--dsw-alias-text-secondary, #8b8f96)',
              },
            },
            current ? current.content : done === todos.length ? '全部完成' : '',
          ),
          h(Progress, { done, total: todos.length, current: current !== undefined }),
          h(
            'span',
            {
              'aria-hidden': true,
              style: {
                color: 'var(--dsw-alias-text-secondary, #8b8f96)',
                transform: open ? 'rotate(180deg)' : 'none',
                transition: 'transform 120ms ease',
                fontSize: '11px',
              },
            },
            '▾',
          ),
        ),
        open
          ? h(
              'div',
              { style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' } },
              todos.map((todo, index) =>
                h(
                  'div',
                  { key: index, style: { display: 'flex', gap: '8px', lineHeight: '18px' } },
                  h(
                    'span',
                    {
                      style: {
                        width: '14px',
                        flex: '0 0 14px',
                        textAlign: 'center',
                        color:
                          todo.status === 'completed'
                            ? 'var(--dsw-alias-text-secondary, #8b8f96)'
                            : todo.status === 'in_progress'
                              ? 'var(--dsw-alias-brand-primary, #7c8cff)'
                              : 'var(--dsw-alias-text-tertiary, #6b6f76)',
                      },
                    },
                    todo.status === 'completed' ? '·' : todo.status === 'in_progress' ? '○' : '·',
                  ),
                  h(
                    'span',
                    {
                      style: {
                        minWidth: 0,
                        color:
                          todo.status === 'completed'
                            ? 'var(--dsw-alias-text-secondary, #8b8f96)'
                            : 'var(--dsw-alias-text-primary, inherit)',
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

    return {
      inject: ['slots'],
      apply(ctx) {
        // A keyed slot lets several entries claim one key and renders the LOWEST
        // priority one, so the shipped `todo_write` row (priority 0) is shadowed
        // by registering below it.
        const register = () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: 'todo_write', priority: -1 }, Row)
        ctx.slots.inject('tool.call.toolview', () => {
          try {
            return register()
          } catch (error) {
            console.warn('[task-steps] could not shadow the todo_write row', error)
            return undefined
          }
        })
      },
    }
  },
})
