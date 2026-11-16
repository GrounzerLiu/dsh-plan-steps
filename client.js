window.__ModuleLoader__.load({
  id: 'dsh-task-steps',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The result text of one tool call, wherever this block keeps it. */
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

    /** The step this call signed off, from its arguments. */
    function citedStep(block) {
      const raw = typeof block?.bodyRaw === 'string' ? block.bodyRaw : null
      if (raw === null) return null
      try {
        const parsed = JSON.parse(raw)
        return typeof parsed.step === 'string' ? parsed.step : null
      } catch {
        return null
      }
    }

    /**
     * Read the position out of the sign-off message:
     * `... the next step is 3 "run tests". (2 open)` or `... Every step ...`.
     * total = nextIndex - 1 + open
     */
    function readPosition(text) {
      if (typeof text !== 'string' || text === '') return null
      if (/Every step in the task list is now complete/.test(text)) return { done: true }
      const next = /the next step is (\d+) "([^"]*)"/.exec(text)
      const open = /\((\d+) open\)/.exec(text)
      if (next === null) return null
      const index = Number(next[1])
      const current = next[2]
      const openCount = open === null ? 0 : Number(open[1])
      const total = index - 1 + openCount
      return { index, current, open: openCount, total, done: false }
    }

    function Bar({ done, total, current }) {
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

    function Row({ block }) {
      try {
        const position = readPosition(resultText(block))
        const step = citedStep(block)
        if (position === null) {
          return h(
            'div',
            { style: { padding: '6px 2px', fontSize: '12px', opacity: 0.75 } },
            step === null ? '完成一步' : '完成：' + step,
          )
        }
        if (position.done === true) {
          return h(
            'div',
            { style: { padding: '6px 2px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '10px' } },
            h('span', { style: { fontWeight: 600 } }, '计划 · 全部完成'),
            h('span', { style: { color: 'var(--dsw-alias-text-secondary, #8b8f96)' } }, step === null ? '' : step),
          )
        }
        const done = position.total - position.open
        return h(
          'div',
          {
            style: {
              padding: '6px 2px',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            },
          },
          h(
            'span',
            { style: { whiteSpace: 'nowrap', fontWeight: 600 } },
            '计划 · 第 ' + String(position.index) + ' / ' + String(position.total) + ' 步',
          ),
          h(
            'span',
            {
              style: {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--dsw-alias-text-primary, inherit)',
              },
            },
            position.current,
          ),
          h(Bar, { done, total: position.total, current: true }),
        )
      } catch (error) {
        return h('div', { style: { padding: '6px 2px', fontSize: '12px', opacity: 0.7 } }, '完成一步')
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        document.documentElement.dataset.taskSteps = 'applied'
        const register = () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: 'complete_step' }, Row)
        ctx.slots.inject('tool.call.toolview', () => {
          try {
            const dispose = register()
            document.documentElement.dataset.taskSteps = 'registered'
            return dispose
          } catch (error) {
            document.documentElement.dataset.taskSteps = 'failed: ' + String(error && error.message)
            return undefined
          }
        })
      },
    }
  },
})
