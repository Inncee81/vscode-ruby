/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

"use strict";

import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles, Breakpoint} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import {readFileSync} from 'fs';
import {basename, dirname} from 'path';
import * as net from 'net';
import * as childProcess from 'child_process';
import {DOMParser} from 'xmldom';
import {Terminal} from './terminal';

/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
export interface LaunchRequestArguments {
	/** An absolute path to the program to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
}

class MockDebugSession extends DebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private _breakpointId = 1000;

	// the initial (and one and only) file we are debugging
	private _sourceFile: string;

	// the contents (= lines) of the one and only file
	private _sourceLines = new Array<string>();

	// maps from sourceFile to array of Breakpoints
	private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();

	private _variableHandles = new Handles<string>();

	private debugSocketServer : net.Socket = null;
	private stackFrameLoaded: Promise<any>;
	private stackFrameLoadedPromiseResolve: (xml: XMLDocument) => void;
	private variableLoaded: Promise<any>;
	private variableLoadedPromiseResolve: (xml: XMLDocument) => void;
	private buffer: string;
	private parser: DOMParser;
	private debugprocess: childProcess.ChildProcess;

	private launchArgs: LaunchRequestArguments;

	/**
	 * Creates a new debug adapter.
	 * We configure the default implementation of a debug adapter here
	 * by specifying that this 'debugger' uses zero-based lines and columns.
	 */
	public constructor() {
		super();

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(false);
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// This debug adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		this.sendResponse(response);
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
		this._sourceFile = args.program;
		this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
		this.launchArgs = args;
		var that = this;

		var runtimeArgs = [];
		var runtimeExecutable = 'rdebug-ide';
		var programArgs = [];
		var processCwd = dirname(args.program);

		this.debugprocess = childProcess.spawn(runtimeExecutable, [args.program, "-xd"], {cwd: processCwd});
		// redirect output to debug console
		this.debugprocess.stdout.on('data', (data: Buffer) => {
			this.sendEvent(new OutputEvent(data.toString() + '', 'stdout'));
		});
		this.debugprocess.stderr.on('data', (data: Buffer) => {
			if (/^Fast Debugger/.test(data.toString())) {
				this.debugSocketServer.connect(1234);
			}
			this.sendEvent(new OutputEvent(data.toString() + '', 'stderr'));
		});
		this.debugprocess.on('exit', () => {
			this.sendEvent(new TerminatedEvent());
		});
		this.debugprocess.on('error', (error: Error) => {
			this.sendEvent(new OutputEvent(error.message, 'stderr'));
		});

		this.stackFrameLoaded = new Promise(resolve => {
            this.stackFrameLoadedPromiseResolve = resolve;
        });

		this.variableLoaded = new Promise(resolve => {
			this.variableLoadedPromiseResolve = resolve;
		});

		this.buffer = "";
		this.parser = new DOMParser();

		this.debugSocketServer = new net.Socket( {
			type: "tcp4"
		});
		this.debugSocketServer.on('connect', (buffer: Buffer) => {
			that.sendEvent(new InitializedEvent());
			that.sendResponse(response);
		});
		this.debugSocketServer.on('end', (ex) => {
			var msg = "Debugger client disconneced, " + ex;
			//that.debugSession.sendEvent(new OutputEvent(msg + "\n", "stderr"));
			console.log(msg);
        });
        this.debugSocketServer.on("data", (buffer: Buffer) => {
			var chunk = buffer.toString();

			if (/^<breakpoint .*?\/>$/.test(chunk)) {
				that.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.THREAD_ID));
				return;
			}

			if (/^<suspended .*?\/>$/.test(chunk)) {
				this.sendEvent(new StoppedEvent("step", MockDebugSession.THREAD_ID));
				return;
			}

			if (
				(/^<frames>/.test(chunk) && !/<\/frames>$/.test(chunk)) ||
				(/^<frame .*?\/>$/.test(chunk) && this.buffer !== "") ||
				(/^<variables>/.test(chunk) && !/<\/variables>$/.test(chunk)) ||
				(/^<variable .*?\/>$/.test(chunk) && this.buffer !== "") ||
				(/^<breakpoints>/.test(chunk) && !/<\/breakpoints>$/.test(chunk)) ||
				(/^<breakpoint .*?\/>$/.test(chunk) && this.buffer !== "")
			) {
				that.buffer += chunk;
				return;
			} else if (
				(/^<variable .*?>$/.test(chunk) && !/<\/variables>$/.test(chunk)) ||
				/<\/variable>$/.test(chunk)
			) {
				that.buffer += chunk;
				return;
			}
			else if (
				/<\/frames>$/.test(chunk) ||
				/<\/variables>$/.test(chunk) ||
				/<\/breakpoints>$/.test(chunk)
			) {
				that.buffer = that.buffer + chunk;
				if (/<\/frames>$/.test(chunk)) {
					var document = that.parser.parseFromString(that.buffer, 'application/xml');
					that.stackFrameLoadedPromiseResolve(document);
				}
				else if (/<\/variables>$/.test(chunk)) {
					console.log("variables\n");
					console.log(that.buffer);
					var document = that.parser.parseFromString(that.buffer, 'application/xml');
					that.variableLoadedPromiseResolve(document);
				}
				that.buffer = "";
			}
		});
        this.debugSocketServer.on("close", d=> {
			var msg = "Debugger client closed, " + d;
			this.sendEvent(new OutputEvent(msg));
			this.sendEvent(new TerminatedEvent());
		});
		this.debugSocketServer.on("error", d=> {
			// var msg = "Debugger client error, " + d;
			// that.sendEvent(new OutputEvent(msg + "\n", "Python"));
			// console.log(msg);
			// // that.onDetachDebugger();
			var msg = "Debugger client error, " + d;
			this.sendEvent(new OutputEvent(msg));
		});
		this.debugSocketServer.on("timeout", d=> {
			var msg = "Debugger client timedout, " + d;
			that.sendEvent(new OutputEvent(msg + "\n", "stderr"));
			console.log(msg);
		});

		if (args.stopOnEntry) {
			this.sendResponse(response);

			// we stop on the first line
			this.sendEvent(new StoppedEvent("entry", MockDebugSession.THREAD_ID));
		}
	}

	// Executed after all breakpints have been set by VS Code
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneRequest, args:
	DebugProtocol.ConfigurationDoneArguments): void {
		var command = ["start"];
		this.debugSocketServer.write(command.join(" ") + "\n");
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		var path = args.source.path;
		var clientLines = args.lines;

		// read file contents into array for direct access
		var lines = readFileSync(path).toString().split('\n');

		var breakpoints = new Array<Breakpoint>();

		// verify breakpoint locations
		for (var i = 0; i < clientLines.length; i++) {
			var l = this.convertClientLineToDebugger(clientLines[i]);
			var verified = false;
			if (l < lines.length) {
				const line = lines[l-1].trim();
				// if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
				if (line.length == 0 || line.indexOf("+") == 0)
					l++;
				// if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
				if (line.indexOf("-") == 0)
					l--;
				// don't set 'verified' to true if the line contains the word 'lazy'
				// in this case the breakpoint will be verified 'lazy' after hitting it once.
				if (line.indexOf("lazy") < 0) {
					verified = true;    // this breakpoint has been validated
				}
			}
			const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(l));
			bp.id = this._breakpointId++;
			var command = ["break", "test.rb:"+bp.line];
			this.debugSocketServer.write(command.join(" ") + "\n");
			breakpoints.push(bp);
		}
		this._breakPoints[path] = breakpoints;

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: breakpoints
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// return the default thread
		response.body = {
			threads: [
				new Thread(MockDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	// Called by VS Code after a StoppedEvent
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this.stackFrameLoaded = new Promise(resolve => {
            this.stackFrameLoadedPromiseResolve = resolve;
        });

		this.stackFrameLoaded.then((xml: XMLDocument) => {
			if (xml.documentElement.nodeName !== 'frames') {
				return;
			}

			const frames = new Array<StackFrame>();
			for(let i= 0; i < xml.documentElement.childNodes.length; i++) {
				var frameNode = xml.documentElement.childNodes.item(i);
				var file = frameNode.attributes.getNamedItem("file");
				var line = frameNode.attributes.getNamedItem("line");
				var bn = basename(file.value);

				//TODO: acutally we should check the workspace
				if (bn === 'ruby-debug-ide.rb' || bn === 'rdebug-ide') {
					break;
				}

				var code = this._sourceLines[this.convertDebuggerLineToClient(+line.value)-1].trim();
				frames.push(new StackFrame(
					i,
					`${code}`,
					new Source(basename(this._sourceFile),
					this.convertDebuggerPathToClient(this._sourceFile)),
					this.convertDebuggerLineToClient(+line.value),
					0
			    ));
			}

			response.body = {
				stackFrames: frames
			};
			this.sendResponse(response);
		});

		this.debugSocketServer.write("where\n");
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
		//scopes.push(new Scope("Closure", this._variableHandles.create("closure_" + frameReference), false));
		//scopes.push(new Scope("Global", this._variableHandles.create("global_" + frameReference), true));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		this.variableLoaded = new Promise(resolve => {
			this.variableLoadedPromiseResolve = resolve;
		});

		this.variableLoaded.then((xml: XMLDocument) => {
			const variables = [];
			for(let i= 0; i < xml.documentElement.childNodes.length; i++) {
				var varNode = xml.documentElement.childNodes.item(i);
				var name = varNode.attributes.getNamedItem("name");
				var value = varNode.attributes.getNamedItem("value");

				variables.push({
					name: name.value,
					value: value.value,
					variablesReference: args.variablesReference
				});
			}

			response.body = {
				variables: variables
			};
			this.sendResponse(response);
		});

		this.debugSocketServer.write("var local\n");
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {

		this.sendResponse(response);
		this.debugSocketServer.write("c\n");
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {

		this.sendResponse(response);
		this.debugSocketServer.write("next\n");
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse): void {
        this.sendResponse(response);
        this.debugSocketServer.write("step\n");
    }
    protected stepOutRequest(response: DebugProtocol.StepInResponse): void {
        this.sendResponse(response);

		//Not sure which command we should use, `finish` will execute all frames.
        //this.debugSocketServer.write("\n");
    }

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		response.body = {
			result: `evaluate(${args.expression})`,
			variablesReference: 0
		};
		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments) {
        this.debugSocketServer.write("quit\n");
        this.sendResponse(response);
    }
}

DebugSession.run(MockDebugSession);