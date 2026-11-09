import Schema from 'schemastery'

export const name = 'dsh-whalebuddy'
export const inject = []
export const Config = Schema.object({
  dataDir: Schema.string().default(''),
})

export function apply(ctx, config) {
  ctx.logger.info('whalebuddy loaded (dataDir=%s)', config.dataDir)
}
