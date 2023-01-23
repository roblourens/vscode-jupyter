// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

'use strict';

import * as path from '../../platform/vscode-path/path';
import { IDumpCellResponse, ISourceMapRequest } from './debuggingTypes';
import { traceError } from '../../platform/logging';
import { KernelDebugAdapterBase } from './kernelDebugAdapterBase';
import { DebugProtocol } from 'vscode-debugprotocol';

/**
 * Concrete implementation of the KernelDebugAdapterBase class that will dump cells
 */
export class KernelDebugAdapter extends KernelDebugAdapterBase {
    private readonly cellToFile = new Map<string, string>();

    // Dump content of given cell into a tmp file and return path to file.
    protected override async dumpCell(index: number): Promise<void> {
        const cell = this.notebookDocument.cellAt(index);
        try {
            const response = await this.session.customRequest('dumpCell', {
                code: cell.document.getText().replace(/\r\n/g, '\n')
            });
            const norm = path.normalize((response as IDumpCellResponse).sourcePath);
            this.fileToCell.set(norm, cell.document.uri);
            this.cellToFile.set(cell.document.uri.toString(), norm);
        } catch (err) {
            traceError(err);
        }
    }
    protected translateRealLocationToDebuggerLocation(
        source: DebugProtocol.Source | undefined,
        _lines?: { line?: number; endLine?: number; lines?: number[] }
    ) {
        if (source && source.path) {
            const mapping = this.cellToFile.get(source.path);
            if (mapping) {
                source.path = mapping;
            }
        }
    }

    protected override async sendRequestToJupyterSession2(
        request: DebugProtocol.Request
    ): Promise<DebugProtocol.Response> {
        if (request.command === 'setBreakpoints') {
            const args = request.arguments as DebugProtocol.SetBreakpointsArguments;
            const sourceMapRequest: ISourceMapRequest = {
                source: { path: '<' + args.source.path! },
                pydevdSourceMaps: []
            };
            // const runtimeSource = this.cellToDebugFileSortedInReverseOrderByLineNumber[0].debugFilePath;
            const runtimeSource = this.cellToFile.get(args.source.path!);
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
            args.source.path = '<' + args.source.path;
        }

        return super.sendRequestToJupyterSession2(request);
    }

    protected getDumpFilesForDeletion() {
        return Array.from(this.cellToFile.values());
    }
}
