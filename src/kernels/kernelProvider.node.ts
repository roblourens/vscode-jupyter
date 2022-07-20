// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';
import { inject, injectable, multiInject } from 'inversify';
import { NotebookDocument, Uri } from 'vscode';
import { IApplicationShell, IWorkspaceService, IVSCodeNotebook } from '../platform/common/application/types';
import { IPythonExecutionFactory } from '../platform/common/process/types.node';
import {
    IAsyncDisposableRegistry,
    IConfigurationService,
    IDisposableRegistry,
    IExtensionContext
} from '../platform/common/types';
import { IStatusProvider } from '../platform/progress/types';
import { BaseCoreKernelProvider, BaseThirdPartyKernelProvider } from './kernelProvider.base';
import { InteractiveWindowView } from '../platform/common/constants';
import { CellOutputDisplayIdTracker } from './execution/cellDisplayIdTracker';
import { sendTelemetryForPythonKernelExecutable } from './helpers.node';
import { Kernel } from './kernel';
import {
    IBaseKernel,
    IKernel,
    INotebookProvider,
    IStartupCodeProvider,
    ITracebackFormatter,
    KernelOptions
} from './types';

/**
 * Node version of a kernel provider. Needed in order to create the node version of a kernel.
 */
@injectable()
export class KernelProvider extends BaseCoreKernelProvider {
    constructor(
        @inject(IAsyncDisposableRegistry) asyncDisposables: IAsyncDisposableRegistry,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(INotebookProvider) private notebookProvider: INotebookProvider,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IApplicationShell) private readonly appShell: IApplicationShell,
        @inject(CellOutputDisplayIdTracker) private readonly outputTracker: CellOutputDisplayIdTracker,
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(IVSCodeNotebook) notebook: IVSCodeNotebook,
        @inject(IPythonExecutionFactory) private readonly pythonExecutionFactory: IPythonExecutionFactory,
        @inject(IStatusProvider) private readonly statusProvider: IStatusProvider,
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @multiInject(ITracebackFormatter) private readonly formatters: ITracebackFormatter[],
        @multiInject(IStartupCodeProvider) private readonly startupCodeProviders: IStartupCodeProvider[]
    ) {
        super(asyncDisposables, disposables, notebook);
    }

    public getOrCreate(notebook: NotebookDocument, options: KernelOptions): IKernel {
        const existingKernelInfo = this.getInternal(notebook);
        if (existingKernelInfo && existingKernelInfo.options.metadata.id === options.metadata.id) {
            return existingKernelInfo.kernel;
        }
        this.disposeOldKernel(notebook);

        const uri = notebook.uri;
        const resourceUri = notebook.notebookType === InteractiveWindowView ? options.resourceUri : uri;
        const waitForIdleTimeout = this.configService.getSettings(resourceUri).jupyterLaunchTimeout;
        const interruptTimeout = this.configService.getSettings(resourceUri).jupyterInterruptTimeout;
        const kernel = new Kernel(
            uri,
            resourceUri,
            notebook,
            options.metadata,
            this.notebookProvider,
            waitForIdleTimeout,
            interruptTimeout,
            this.appShell,
            options.controller,
            this.configService,
            this.outputTracker,
            this.workspaceService,
            this.statusProvider,
            options.creator,
            this.context,
            this.formatters,
            this.startupCodeProviders,
            () => {
                if (kernel.session) {
                    return sendTelemetryForPythonKernelExecutable(
                        kernel.session,
                        kernel.resourceUri,
                        kernel.kernelConnectionMetadata,
                        this.pythonExecutionFactory
                    );
                } else {
                    return Promise.resolve();
                }
            }
        ) as IKernel;
        kernel.onRestarted(() => this._onDidRestartKernel.fire(kernel), this, this.disposables);
        kernel.onDisposed(() => this._onDidDisposeKernel.fire(kernel), this, this.disposables);
        kernel.onStarted(() => this._onDidStartKernel.fire(kernel), this, this.disposables);
        kernel.onStatusChanged(
            (status) => this._onKernelStatusChanged.fire({ kernel, status }),
            this,
            this.disposables
        );
        this.asyncDisposables.push(kernel);
        this.storeKernel(notebook, options, kernel);
        this.deleteMappingIfKernelIsDisposed(uri, kernel);
        return kernel;
    }
}

@injectable()
export class ThirdPartyKernelProvider extends BaseThirdPartyKernelProvider {
    constructor(
        @inject(IAsyncDisposableRegistry) asyncDisposables: IAsyncDisposableRegistry,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(INotebookProvider) private notebookProvider: INotebookProvider,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IApplicationShell) private readonly appShell: IApplicationShell,
        @inject(CellOutputDisplayIdTracker) private readonly outputTracker: CellOutputDisplayIdTracker,
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(IVSCodeNotebook) notebook: IVSCodeNotebook,
        @inject(IPythonExecutionFactory) private readonly pythonExecutionFactory: IPythonExecutionFactory,
        @inject(IStatusProvider) private readonly statusProvider: IStatusProvider,
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @multiInject(ITracebackFormatter) private readonly formatters: ITracebackFormatter[],
        @multiInject(IStartupCodeProvider) private readonly startupCodeProviders: IStartupCodeProvider[]
    ) {
        super(asyncDisposables, disposables, notebook);
    }

    public getOrCreate(uri: Uri, options: KernelOptions): IBaseKernel {
        // const notebook = this.
        const existingKernelInfo = this.getInternal(uri);
        if (existingKernelInfo && existingKernelInfo.options.metadata.id === options.metadata.id) {
            return existingKernelInfo.kernel;
        }
        this.disposeOldKernel(uri);

        const resourceUri = uri;
        const waitForIdleTimeout = this.configService.getSettings(resourceUri).jupyterLaunchTimeout;
        const interruptTimeout = this.configService.getSettings(resourceUri).jupyterInterruptTimeout;
        let kernel: Kernel = new Kernel(
            uri,
            resourceUri,
            undefined,
            options.metadata,
            this.notebookProvider,
            waitForIdleTimeout,
            interruptTimeout,
            this.appShell,
            options.controller,
            this.configService,
            this.outputTracker,
            this.workspaceService,
            this.statusProvider,
            options.creator,
            this.context,
            this.formatters,
            this.startupCodeProviders,
            () => {
                if (kernel.session) {
                    return sendTelemetryForPythonKernelExecutable(
                        kernel.session,
                        kernel.resourceUri,
                        kernel.kernelConnectionMetadata,
                        this.pythonExecutionFactory
                    );
                } else {
                    return Promise.resolve();
                }
            }
        );
        kernel.onRestarted(() => this._onDidRestartKernel.fire(kernel), this, this.disposables);
        kernel.onDisposed(() => this._onDidDisposeKernel.fire(kernel), this, this.disposables);
        kernel.onStarted(() => this._onDidStartKernel.fire(kernel), this, this.disposables);
        kernel.onStatusChanged(
            (status) => this._onKernelStatusChanged.fire({ kernel, status }),
            this,
            this.disposables
        );
        this.asyncDisposables.push(kernel);
        this.storeKernel(uri, options, kernel);
        this.deleteMappingIfKernelIsDisposed(uri, kernel);
        return kernel;
    }
}
