export default () => ({
  start(context) {
    context.commands.register({
      id: 'greet',
      label: 'Say hello',
      run: () => context.notify('__HIBI_GREETING__'),
    })
  },
})
