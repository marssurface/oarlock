import type { BenchTask } from '../types.ts'
import { abortTurn } from './abort-turn.ts'
import { addFeature } from './add-feature.ts'
import { badArguments } from './bad-arguments.ts'
import { compaction } from './compaction.ts'
import { dangerousBash } from './dangerous-bash.ts'
import { denyWrite } from './deny-write.ts'
import { fixBug } from './fix-bug.ts'
import { largeFile } from './large-file.ts'
import { multiTool } from './multi-tool.ts'
import { multiTurn } from './multi-turn.ts'
import { outputTruncation } from './output-truncation.ts'
import { parallelTools } from './parallel-tools.ts'
import { readAndAnswer } from './read-and-answer.ts'
import { retry } from './retry.ts'
import { sandbox } from './sandbox.ts'
import { subagent } from './subagent.ts'
import { toolTimeout } from './tool-timeout.ts'

/** The suite, ordered from "must always work" to "harder runtime paths". */
export const tasks: BenchTask[] = [
  readAndAnswer,
  multiTool,
  fixBug,
  addFeature,
  largeFile,
  sandbox,
  denyWrite,
  dangerousBash,
  badArguments,
  parallelTools,
  retry,
  multiTurn,
  subagent,
  toolTimeout,
  outputTruncation,
  abortTurn,
  compaction,
]
