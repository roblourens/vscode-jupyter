// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { assert } from 'chai';
import { IDisposable } from 'monaco-editor';
import { anything, instance, mock, when } from 'ts-mockito';
import {
    EventEmitter,
    Memento,
    NotebookCellKind,
    Uri,
    NotebookContentProvider as VSCodeNotebookContentProvider,
    NotebookDocument,
    NotebookCellMetadata,
    CancellationTokenSource
} from 'vscode';
import { IVSCodeNotebook } from '../../../client/common/application/types';
import { MARKDOWN_LANGUAGE, PYTHON_LANGUAGE } from '../../../client/common/constants';
import { disposeAllDisposables } from '../../../client/common/helpers';
import { ICryptoUtils } from '../../../client/common/types';
import { NotebookContentProvider } from '../../../client/datascience/notebook/contentProvider';
import { NotebookEditorCompatibilitySupport } from '../../../client/datascience/notebook/notebookEditorCompatibilitySupport';
import { INotebookStorageProvider } from '../../../client/datascience/notebookStorage/notebookStorageProvider';
import { createNotebookModel } from './helper';
/* eslint-disable @typescript-eslint/no-explicit-any */
suite('DataScience - VSCode Notebook ContentProvider', () => {
    let storageProvider: INotebookStorageProvider;
    let contentProvider: VSCodeNotebookContentProvider;
    const fileUri = Uri.file('a.ipynb');
    const disposables: IDisposable[] = [];
    setup(async () => {
        storageProvider = mock<INotebookStorageProvider>();
        const compatSupport = mock(NotebookEditorCompatibilitySupport);
        when(compatSupport.canOpenWithOurNotebookEditor(anything())).thenReturn(true);
        when(compatSupport.canOpenWithVSCodeNotebookEditor(anything())).thenReturn(true);
        const vscNotebooks = mock<IVSCodeNotebook>();
        when(vscNotebooks.onDidSaveNotebookDocument).thenReturn(new EventEmitter<NotebookDocument>().event);
        const memento = mock<Memento>();
        when(memento.get(anything())).thenReturn();
        contentProvider = new NotebookContentProvider(
            instance(storageProvider),
            instance(compatSupport),
            instance(vscNotebooks)
        );
    });
    teardown(() => disposeAllDisposables(disposables));
    [true, false].forEach((isNotebookTrusted) => {
        suite(isNotebookTrusted ? 'Trusted Notebook' : 'Un-trusted notebook', () => {
            test('Return notebook with 2 cells', async () => {
                const model = createNotebookModel(
                    isNotebookTrusted,
                    Uri.file('any'),
                    instance(mock<Memento>()),
                    instance(mock<ICryptoUtils>()),
                    {
                        cells: [
                            {
                                cell_type: 'code',
                                execution_count: 10,
                                outputs: [],
                                source: 'print(1)',
                                metadata: {}
                            },
                            {
                                cell_type: 'markdown',
                                source: '# HEAD',
                                metadata: {}
                            }
                        ]
                    }
                );
                when(storageProvider.getOrCreateModel(anything())).thenResolve(model);

                const notebook = await contentProvider.openNotebook(fileUri, {}, new CancellationTokenSource().token);

                assert.isOk(notebook);

                assert.deepEqual(notebook.cells, [
                    {
                        kind: NotebookCellKind.Code,
                        language: PYTHON_LANGUAGE,
                        outputs: [],
                        source: 'print(1)',
                        metadata: new NotebookCellMetadata().with({
                            custom: {
                                metadata: {}
                            }
                        }),
                        latestExecutionSummary: {
                            executionOrder: 10
                        }
                    },
                    {
                        kind: NotebookCellKind.Markdown,
                        language: MARKDOWN_LANGUAGE,
                        outputs: [],
                        source: '# HEAD',
                        metadata: new NotebookCellMetadata().with({
                            custom: {
                                metadata: {}
                            }
                        }),
                        latestExecutionSummary: undefined
                    }
                ]);
            });

            test('Return notebook with csharp language', async () => {
                const model = createNotebookModel(
                    isNotebookTrusted,
                    Uri.file('any'),
                    instance(mock<Memento>()),
                    instance(mock<ICryptoUtils>()),
                    {
                        metadata: {
                            language_info: {
                                name: 'csharp'
                            },
                            orig_nbformat: 5
                        },
                        cells: [
                            {
                                cell_type: 'code',
                                execution_count: 10,
                                outputs: [],
                                source: 'Console.WriteLine("1")',
                                metadata: {}
                            },
                            {
                                cell_type: 'markdown',
                                source: '# HEAD',
                                metadata: {}
                            }
                        ]
                    }
                );
                when(storageProvider.getOrCreateModel(anything())).thenResolve(model);

                const notebook = await contentProvider.openNotebook(fileUri, {}, new CancellationTokenSource().token);

                assert.isOk(notebook);

                assert.deepEqual(notebook.cells, [
                    {
                        kind: NotebookCellKind.Code,
                        language: 'csharp',
                        outputs: [],
                        source: 'Console.WriteLine("1")',
                        metadata: new NotebookCellMetadata().with({
                            custom: {
                                metadata: {}
                            }
                        }),
                        latestExecutionSummary: {
                            executionOrder: 10
                        }
                    },
                    {
                        kind: NotebookCellKind.Markdown,
                        language: MARKDOWN_LANGUAGE,
                        outputs: [],
                        source: '# HEAD',
                        metadata: new NotebookCellMetadata().with({
                            custom: {
                                metadata: {}
                            }
                        }),
                        latestExecutionSummary: undefined
                    }
                ]);
            });
            test('Verify mime types and order', () => {
                // https://github.com/microsoft/vscode-python/issues/11880
            });
        });
    });
});
