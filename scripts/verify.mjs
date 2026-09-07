#!/usr/bin/env node
import { verify } from './verification/run.mjs'
await verify(process.argv.slice(2))
