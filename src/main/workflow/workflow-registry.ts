import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WorkflowDefinition,
  WorkflowDefinitionSchema,
  LegacyWorkflowDefinition,
  LegacyWorkflowDefinitionSchema,
} from './workflow-schema';

export interface WorkflowItem {
  id: string;
  name: string;
  description: string;
  version: '1.0';
  category: 'qa' | 'ecommerce' | 'security' | 'custom';
  isBuiltIn: boolean;
  definition: WorkflowDefinition | LegacyWorkflowDefinition;
  legacy?: boolean;
}

export const BUILTIN_WORKFLOWS: WorkflowItem[] = [
  {
    id: 'wf-storefront-qa',
    name: 'Haravan / Sapo Theme Storefront QA & Audit',
    description: 'Tự động kiểm tra vỡ layout ngang (overflow), ảnh hỏng 404, lỗi console JS và chụp ảnh báo cáo.',
    version: '1.0',
    category: 'qa',
    isBuiltIn: true,
    definition: {
      version: '1.0',
      name: 'Haravan / Sapo Theme Storefront QA & Audit',
      description: 'Tự động kiểm tra vỡ layout ngang (overflow), ảnh hỏng 404, lỗi console JS và chụp ảnh báo cáo.',
      steps: [
        {
          id: 'step-viewport-fhd',
          name: 'Thiết lập Viewport Desktop Full HD (1920x1080)',
          type: 'browser.set_viewport',
          params: { width: 1920, height: 1080 },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: false,
        },
        {
          id: 'step-check-overflow',
          name: 'Quét phát hiện phần tử tràn ngang (Horizontal Scrollbar / Layout Overflow)',
          type: 'qa.check_overflow',
          params: { thresholdPx: 2 },
          timeoutMs: 8000,
          retryCount: 0,
          continueOnError: true,
        },
        {
          id: 'step-check-broken-images',
          name: 'Kiểm tra ảnh hỏng 404 hoặc không tải được (Broken Images)',
          type: 'qa.check_broken_images',
          params: {},
          timeoutMs: 8000,
          retryCount: 0,
          continueOnError: true,
        },
        {
          id: 'step-check-console-errors',
          name: 'Thu thập lỗi JavaScript Console & Cảnh báo nghiêm trọng',
          type: 'qa.check_console_errors',
          params: { level: 'error' },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: true,
        },
        {
          id: 'step-capture-evidence',
          name: 'Chụp ảnh màn hình nghiệm thu giao diện Viewport (.PNG)',
          type: 'browser.screenshot',
          params: { format: 'png' },
          timeoutMs: 10000,
          retryCount: 1,
          continueOnError: false,
        },
        {
          id: 'step-generate-qa-report',
          name: 'Tạo báo cáo tổng hợp kết quả kiểm thử (QA Evidence Markdown)',
          type: 'report.generate',
          params: { format: 'markdown', title: 'Theme Storefront QA Report' },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: false,
        },
      ],
    },
  },
  {
    id: 'wf-mobile-pdp-stress-test',
    name: 'Mobile Product Page (PDP) & Buy Button Test',
    description: 'Chuyển sang khung nhìn iPhone 14 Pro, cuộn trang kiểm tra sticky CTA, tìm nút Mua ngay và trích xuất giá.',
    version: '1.0',
    category: 'ecommerce',
    isBuiltIn: true,
    definition: {
      version: '1.0',
      name: 'Mobile Product Page (PDP) & Buy Button Test',
      description: 'Chuyển sang khung nhìn iPhone 14 Pro, cuộn trang kiểm tra sticky CTA, tìm nút Mua ngay và trích xuất giá.',
      steps: [
        {
          id: 'step-mobile-preset',
          name: 'Chuyển sang chuẩn thiết bị di động (iPhone 14 Pro / 393x852)',
          type: 'browser.set_device_preset',
          params: { presetId: 'phone-iphone14pro' },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: false,
        },
        {
          id: 'step-scroll-smooth',
          name: 'Cuộn trang mượt mà 600px để kích hoạt Lazy-load ảnh và CTA',
          type: 'browser.scroll',
          params: { x: 0, y: 600, durationMs: 400 },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: true,
        },
        {
          id: 'step-wait-buy-btn',
          name: 'Chờ nút mua hàng (.btn-buy-now, button[type=submit], .btn-add-cart)',
          type: 'browser.wait_for_selector',
          params: { selector: 'button[type="submit"], .btn-addtocart, .btn-buy-now, [data-action="add-to-cart"]' },
          timeoutMs: 8000,
          retryCount: 1,
          continueOnError: true,
        },
        {
          id: 'step-highlight-buy-btn',
          name: 'Tô viền màu nổi bật vào nút mua hàng để kiểm tra vị trí bấm',
          type: 'browser.highlight',
          params: { selector: 'button[type="submit"], .btn-addtocart, .btn-buy-now, [data-action="add-to-cart"]', color: '#10b981' },
          timeoutMs: 4000,
          retryCount: 0,
          continueOnError: true,
        },
        {
          id: 'step-extract-product-info',
          name: 'Trích xuất thông tin tiêu đề và giá sản phẩm từ DOM',
          type: 'browser.extract_dom',
          params: { selector: 'h1, .product-title, .price, .product-price' },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: true,
        },
        {
          id: 'step-screenshot-mobile',
          name: 'Chụp ảnh màn hình Viewport trên giao diện di động',
          type: 'browser.screenshot',
          params: { format: 'png' },
          timeoutMs: 10000,
          retryCount: 0,
          continueOnError: false,
        },
      ],
    },
  },
  {
    id: 'wf-theme-security-scan',
    name: 'Theme Code & Secrets Leak Safety Scan',
    description: 'Kiểm tra mã nguồn theme trong thư mục làm việc để đảm bảo không bị lộ API Key, Secret Token hoặc mã độc.',
    version: '1.0',
    category: 'security',
    isBuiltIn: true,
    definition: {
      version: '1.0',
      name: 'Theme Code & Secrets Leak Safety Scan',
      description: 'Kiểm tra mã nguồn theme trong thư mục làm việc để đảm bảo không bị lộ API Key, Secret Token hoặc mã độc.',
      steps: [
        {
          id: 'step-read-config',
          name: 'Đọc file cấu hình package.json hoặc theme settings',
          type: 'file.read',
          params: { path: 'package.json' },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: true,
        },
        {
          id: 'step-assert-no-secret',
          name: 'Kiểm tra không chứa chuỗi nhạy cảm hardcoded bí mật',
          type: 'file.assert_not_contains',
          params: { path: 'package.json', forbiddenPatterns: ['PRIVATE_KEY', 'AWS_SECRET', 'HARAVAN_SECRET'] },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: true,
        },
        {
          id: 'step-generate-security-report',
          name: 'Tạo báo cáo kiểm tra an toàn bảo mật mã nguồn',
          type: 'report.generate',
          params: { format: 'markdown', title: 'Theme Security Scan Report' },
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: false,
        },
      ],
    },
  },
];

export class WorkflowRegistry {
  private customWorkflows = new Map<string, WorkflowItem>();
  private storageDir: string | null = null;

  constructor(storageDir?: string) {
    if (storageDir) {
      this.storageDir = storageDir;
      this.loadFromDisk();
    }
  }

  public setStorageDir(storageDir: string): void {
    this.storageDir = storageDir;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!this.storageDir) return;
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
        return;
      }
      const files = fs.readdirSync(this.storageDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.storageDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          let json: Record<string, unknown>;
          try {
            const parsedJson = JSON.parse(content);
            if (!parsedJson || typeof parsedJson !== 'object') {
              throw new Error('Workflow file content must be a JSON object');
            }
            json = parsedJson as Record<string, unknown>;
          } catch (parseErr) {
            console.warn(`[workflow-registry] Corrupt JSON in workflow file ${file}, quarantining to .invalid:`, parseErr);
            this.quarantineFile(filePath);
            continue;
          }

          const rawDef = json.definition || json;
          const fileCustomId = typeof json.id === 'string' ? json.id : `wf-custom-${file.replace(/\.json$/, '')}`;
          const unionParsed = WorkflowDefinitionSchema.safeParse(rawDef);
          if (unionParsed.success) {
            const id = fileCustomId;
            this.customWorkflows.set(id, {
              id,
              name: unionParsed.data.name,
              description: unionParsed.data.description || '',
              version: unionParsed.data.version,
              category: 'custom',
              isBuiltIn: false,
              definition: unionParsed.data,
            });
            continue;
          }

          // Fall back to legacy schema with unvalidated params
          const legacyParsed = LegacyWorkflowDefinitionSchema.safeParse(rawDef);
          if (legacyParsed.success) {
            console.warn(`[workflow-registry] Workflow ${file} loaded using legacy schema with unvalidated params`);
            const id = fileCustomId;
            this.customWorkflows.set(id, {
              id,
              name: legacyParsed.data.name,
              description: legacyParsed.data.description || '',
              version: legacyParsed.data.version,
              category: 'custom',
              isBuiltIn: false,
              definition: legacyParsed.data,
              legacy: true,
            });
            continue;
          }

          // Double-fail: neither unionSchema nor legacySchema validated; quarantine file
          console.warn(
            `[workflow-registry] Workflow ${file} failed both union and legacy schema validation; quarantining to .invalid`
          );
          this.quarantineFile(filePath);
        } catch (err) {
          console.warn(`[workflow-registry] Unexpected error processing ${file}, quarantining to .invalid:`, err);
          this.quarantineFile(filePath);
        }
      }
    } catch (err) {
      console.error('[workflow-registry] Failed to read workflows storage dir:', err);
    }
  }

  private quarantineFile(filePath: string): void {
    try {
      const invalidPath = filePath.endsWith('.json') ? filePath.replace(/\.json$/, '.invalid') : `${filePath}.invalid`;
      if (fs.existsSync(invalidPath)) {
        try {
          fs.unlinkSync(invalidPath);
        } catch {}
      }
      fs.renameSync(filePath, invalidPath);
    } catch (err) {
      console.error(`[workflow-registry] Failed to quarantine file ${filePath}:`, err);
    }
  }

  public getAll(): WorkflowItem[] {
    const list = [...BUILTIN_WORKFLOWS];
    for (const item of this.customWorkflows.values()) {
      list.push(item);
    }
    return list;
  }

  public getById(id: string): WorkflowItem | undefined {
    return this.getAll().find((wf) => wf.id === id);
  }

  public saveCustom(item: { id?: string; name: string; description?: string; steps: unknown[] }): WorkflowItem {
    const id = item.id || `wf-custom-${Date.now()}`;
    const rawDef = {
      version: '1.0' as const,
      name: item.name,
      description: item.description,
      steps: item.steps,
    };

    let definition: WorkflowDefinition | LegacyWorkflowDefinition;
    let isLegacy = false;

    const unionParsed = WorkflowDefinitionSchema.safeParse(rawDef);
    if (unionParsed.success) {
      definition = unionParsed.data;
    } else {
      const legacyParsed = LegacyWorkflowDefinitionSchema.safeParse(rawDef);
      if (legacyParsed.success) {
        console.warn(`[workflow-registry] Custom workflow ${id} saved using legacy schema with unvalidated params`);
        definition = legacyParsed.data;
        isLegacy = true;
      } else {
        throw unionParsed.error;
      }
    }

    const workflowItem: WorkflowItem = {
      id,
      name: definition.name,
      description: definition.description || '',
      version: '1.0',
      category: 'custom',
      isBuiltIn: false,
      definition,
      ...(isLegacy ? { legacy: true } : {}),
    };
    this.customWorkflows.set(id, workflowItem);

    if (this.storageDir) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
        fs.writeFileSync(path.join(this.storageDir, `${id}.json`), JSON.stringify(workflowItem, null, 2), 'utf-8');
      } catch (err) {
        console.error('[workflow-registry] Failed to persist custom workflow:', err);
      }
    }

    return workflowItem;
  }

  public deleteCustom(id: string): boolean {
    if (this.customWorkflows.has(id)) {
      this.customWorkflows.delete(id);
      if (this.storageDir) {
        try {
          const filePath = path.join(this.storageDir, `${id}.json`);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch {}
      }
      return true;
    }
    return false;
  }
}
