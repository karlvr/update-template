#!/usr/bin/env node
import { update } from './update.js'
import process from 'process'

update().then(status => {
	process.exit(status)
}).catch(error => {
	console.error(error)
	process.exit(1)
})
