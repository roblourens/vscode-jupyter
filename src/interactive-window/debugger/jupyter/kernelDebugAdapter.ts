// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

'use strict';

import { DebugAdapterTracker, DebugSession, NotebookDocument, Uri } from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol';
import { getInteractiveCellMetadata } from '../../../interactive-window/helpers';
import { IKernel, IKernelConnectionSession } from '../../../kernels/types';
import {
    IDebugLocationTrackerFactory,
    IDumpCellResponse,
    ISourceMapRequest
} from '../../../notebooks/debugger/debuggingTypes';
import { KernelDebugAdapterBase } from '../../../notebooks/debugger/kernelDebugAdapterBase';
import { IDebugService } from '../../../platform/common/application/types';
import { IPlatformService } from '../../../platform/common/platform/types';
import { traceError, traceInfoIfCI } from '../../../platform/logging';
import * as path from '../../../platform/vscode-path/path';
import { InteractiveCellMetadata } from '../../editor-integration/types';
/**
 * KernelDebugAdapter listens to debug messages in order to translate file requests into real files
 * (Interactive Window generally executes against a real file)
 * Files from the kernel are pointing to cells, whereas the user is looking at a real file.
 */
export class KernelDebugAdapter extends KernelDebugAdapterBase {
    private readonly debugLocationTracker?: DebugAdapterTracker;
    private readonly cellToDebugFileSortedInReverseOrderByLineNumber: {
        debugFilePath: string;
        interactiveWindow: Uri;
        lineOffset: number;
        metadata: InteractiveCellMetadata;
    }[] = [];

    constructor(
        session: DebugSession,
        notebookDocument: NotebookDocument,
        jupyterSession: IKernelConnectionSession,
        kernel: IKernel | undefined,
        platformService: IPlatformService,
        debugService: IDebugService,
        debugLocationTrackerFactory?: IDebugLocationTrackerFactory
    ) {
        super(session, notebookDocument, jupyterSession, kernel, platformService, debugService);
        if (debugLocationTrackerFactory) {
            this.debugLocationTracker = debugLocationTrackerFactory.createDebugAdapterTracker(
                session
            ) as DebugAdapterTracker;
            if (this.debugLocationTracker.onWillStartSession) {
                this.debugLocationTracker.onWillStartSession();
            }
            this.onDidSendMessage(
                (msg) => {
                    if (this.debugLocationTracker?.onDidSendMessage) {
                        this.debugLocationTracker.onDidSendMessage(msg);
                    }
                },
                this,
                this.disposables
            );
            this.onDidEndSession(
                () => {
                    if (this.debugLocationTracker?.onWillStopSession) {
                        this.debugLocationTracker.onWillStopSession();
                    }
                },
                this,
                this.disposables
            );
        }
    }

    override handleClientMessageAsync(message: DebugProtocol.ProtocolMessage): Promise<void> {
        traceInfoIfCI(`KernelDebugAdapter::handleMessage ${JSON.stringify(message, undefined, ' ')}`);
        if (message.type === 'request' && this.debugLocationTracker?.onWillReceiveMessage) {
            this.debugLocationTracker.onWillReceiveMessage(message);
        }
        if (message.type === 'response' && this.debugLocationTracker?.onDidSendMessage) {
            this.debugLocationTracker.onDidSendMessage(message);
        }
        return super.handleClientMessageAsync(message);
    }

    // Dump content of given cell into a tmp file and return path to file.
    protected async dumpCell(index: number): Promise<void> {
        const cell = this.notebookDocument.cellAt(index);
        const metadata = getInteractiveCellMetadata(cell);
        if (!metadata) {
            throw new Error('Not an interactive window cell');
        }
        try {
            const code = (metadata.generatedCode?.code || cell.document.getText()).replace(/\r\n/g, '\n');
            const response = await this.session.customRequest('dumpCell', { code });

            // We know jupyter will strip out leading white spaces, hence take that into account.
            const norm = path.normalize((response as IDumpCellResponse).sourcePath);
            this.fileToCell.set(norm, Uri.parse(metadata.interactive.uristring));

            // If this cell doesn't have a cell marker, then
            // Jupyter will strip out any leading whitespace.
            // Take that into account.
            let numberOfStrippedLines = 0;
            if (metadata.generatedCode && !metadata.generatedCode.hasCellMarker) {
                numberOfStrippedLines = metadata.generatedCode.firstNonBlankLineIndex;
            }
            this.cellToDebugFileSortedInReverseOrderByLineNumber.push({
                debugFilePath: norm,
                interactiveWindow: Uri.parse(metadata.interactive.uristring),
                metadata,
                lineOffset:
                    numberOfStrippedLines +
                    metadata.interactive.lineIndex +
                    (metadata.generatedCode?.lineOffsetRelativeToIndexOfFirstLineInCell || 0)
            });
            // Order cells in reverse order.
            this.cellToDebugFileSortedInReverseOrderByLineNumber.sort(
                (a, b) => b.metadata.interactive.lineIndex - a.metadata.interactive.lineIndex
            );
        } catch (err) {
            traceError(`Failed to dump cell for ${cell.index} with code ${metadata.interactive.originalSource}`, err);
        }
    }
    protected override translateDebuggerFileToRealFile(
        source: DebugProtocol.Source | undefined,
        lines?: { line?: number; endLine?: number; lines?: number[] }
    ) {
        if (!source || !source.path || !lines || (typeof lines.line !== 'number' && !Array.isArray(lines.lines))) {
            return;
        }
        // Find the cell that matches this line in the IW file by mapping the debugFilePath to the IW file.
        const cell = this.cellToDebugFileSortedInReverseOrderByLineNumber.find(
            (item) => item.debugFilePath === source.path
        );
        if (!cell) {
            return;
        }
        source.name = path.basename(cell.interactiveWindow.path);
        source.path = cell.interactiveWindow.toString();
        if (typeof lines?.endLine === 'number') {
            lines.endLine = lines.endLine + (cell.lineOffset || 0);
        }
        if (typeof lines?.line === 'number') {
            lines.line = lines.line + (cell.lineOffset || 0);
        }
        if (lines?.lines && Array.isArray(lines?.lines)) {
            lines.lines = lines?.lines.map((line) => line + (cell.lineOffset || 0));
        }
    }
    protected override translateRealLocationToDebuggerLocation(
        source: DebugProtocol.Source | undefined,
        location?: { line?: number; endLine?: number; breakpoints?: { line: number }[] }
    ) {
        if (
            !source ||
            !source.path ||
            !location ||
            (typeof location.line !== 'number' && !Array.isArray(location.breakpoints))
        ) {
            return;
        }

        const startLine = location.line || location.breakpoints![0].line;
        // Find the cell that matches this line in the IW file by mapping the debugFilePath to the IW file.
        const cell = this.cellToDebugFileSortedInReverseOrderByLineNumber.find(
            (item) => startLine >= item.metadata.interactive.lineIndex + 1
        );
        if (!cell || cell.interactiveWindow.path !== source.path) {
            return;
        }

        source.path = cell.debugFilePath;

        if (typeof location?.endLine === 'number') {
            location.endLine = location.endLine - (cell.lineOffset || 0);
        }
        if (typeof location?.line === 'number') {
            location.line = location.line - (cell.lineOffset || 0);
        }
        if (Array.isArray(location?.breakpoints)) {
            location.breakpoints.forEach((bp) => (bp.line = bp.line - (cell.lineOffset || 0)));
        }
    }

    protected override async sendRequestToJupyterSession2(
        request: DebugProtocol.Request
    ): Promise<DebugProtocol.Response> {
        if (request.command === 'setBreakpoints') {
            const args = request.arguments as DebugProtocol.SetBreakpointsArguments;
            const sourceMapRequest: ISourceMapRequest = { source: { path: args.source.path! }, pydevdSourceMaps: [] };
            const runtimeSource = this.cellToDebugFileSortedInReverseOrderByLineNumber[0].debugFilePath;
            sourceMapRequest.pydevdSourceMaps = [
                // { endLine: 3, line: 1, runtimeLine: 2, runtimeSource: { path: '<ipython-input-1-09853089e9ea>' } }
                {
                    endLine: 3,
                    line: 1,
                    runtimeLine: 2,
                    runtimeSource: {
                        // path: '/var/folders/tx/p0ycbfpj37786p760wwdg6y80000gn/T/ipykernel_4963/3029800661.py'
                        path: '/private' + runtimeSource
                    }
                }
            ];
            await this.session.customRequest('setPydevdSourceMap', sourceMapRequest);
            return super.sendRequestToJupyterSession2(request);
        }
        if (request.command === '2setBreakpoints') {
            const args = request.arguments as DebugProtocol.SetBreakpointsArguments;
            if (this.cellToDebugFileSortedInReverseOrderByLineNumber[0]?.interactiveWindow.path !== args.source.path) {
                return super.sendRequestToJupyterSession2(request);
            }

            let currentCellLine: number | undefined;
            let currentCellBps: DebugProtocol.SourceBreakpoint[] = [];
            const setBreakpointsRequests: Promise<DebugProtocol.SetBreakpointsResponse>[] = [];
            const sendIfNeeded = () => {
                if (currentCellBps.length) {
                    const clonedRequest: DebugProtocol.SetBreakpointsRequest = JSON.parse(JSON.stringify(request));
                    clonedRequest.arguments.breakpoints = currentCellBps;
                    setBreakpointsRequests.push(
                        super.sendRequestToJupyterSession2(
                            clonedRequest
                        ) as Promise<DebugProtocol.SetBreakpointsResponse>
                    );
                }
            };

            for (const bp of request.arguments.breakpoints ?? []) {
                const cellForBp = this.cellToDebugFileSortedInReverseOrderByLineNumber.find(
                    (item) => item.metadata.interactive.lineIndex + 1 <= bp.line
                );
                const cellLineForBp = cellForBp?.lineOffset;
                if (typeof cellLineForBp === 'number' && cellLineForBp !== currentCellLine) {
                    sendIfNeeded();
                    currentCellLine = cellLineForBp;
                    currentCellBps = [bp];
                } else if (typeof cellLineForBp === 'number') {
                    currentCellBps.push(bp);
                } else {
                    const fakeBreakpoint = { ...bp, ...{ verified: true } };
                    setBreakpointsRequests.push(
                        Promise.resolve({
                            body: { breakpoints: [fakeBreakpoint] }
                        } as DebugProtocol.SetBreakpointsResponse)
                    );
                }
            }
            sendIfNeeded();

            const responses = await Promise.all(setBreakpointsRequests);
            const newResponse: DebugProtocol.SetBreakpointsResponse = JSON.parse(JSON.stringify(responses[0]));
            responses.slice(1).forEach((response) => {
                newResponse.body.breakpoints = newResponse.body.breakpoints.concat(response.body.breakpoints ?? []);
            });
            return newResponse;
        }

        return super.sendRequestToJupyterSession2(request);
    }

    protected getDumpFilesForDeletion() {
        return this.cellToDebugFileSortedInReverseOrderByLineNumber.map((item) => item.debugFilePath);
    }
}
