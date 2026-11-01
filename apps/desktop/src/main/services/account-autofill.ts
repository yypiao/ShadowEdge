import { ShadowEdgeError } from '@shadowedge/core';
import type { AccountAutofillResult, Uuid } from '@shadowedge/core';
import type { BrowserContext, Page } from 'patchright';
import type { BrowserKernel } from '@shadowedge/kernel';
import type { AccountRepository } from './account-repository.js';

interface AccountAutofillDeps {
  accountRepo: AccountRepository;
  kernel: BrowserKernel;
}

export async function autofillAccount(
  deps: AccountAutofillDeps,
  input: { id: Uuid; submit?: boolean },
): Promise<AccountAutofillResult> {
  const { credential, password } = deps.accountRepo.reveal(input.id);
  const context = deps.kernel.getAutomationContext(credential.profileId);
  const page = findOriginPage(context, credential.origin);
  assertOrigin(page, credential.origin);

  // 在任何字段填充前先验证密码框，避免恶意页面用同名文本框骗取密文。
  const passwordField = page.locator(credential.passwordSelector);
  const fieldType = await passwordField.getAttribute('type');
  if (fieldType?.toLowerCase() !== 'password') {
    throw new ShadowEdgeError(
      'E_ACCOUNT_SELECTOR_UNSAFE',
      '密码选择器没有指向 type=password 的输入框',
    );
  }
  if (input.submit && !credential.submitSelector) {
    throw new ShadowEdgeError('E_ACCOUNT_SELECTOR_UNSAFE', '该凭据未配置提交按钮选择器');
  }

  await page.locator(credential.usernameSelector).fill(credential.username);
  assertOrigin(page, credential.origin);
  await passwordField.fill(password);
  assertOrigin(page, credential.origin);

  const submitted = input.submit === true;
  if (submitted) await page.locator(credential.submitSelector!).click();
  return {
    credentialId: credential.id,
    profileId: credential.profileId,
    origin: credential.origin,
    submitted,
  };
}

function findOriginPage(context: BrowserContext, expectedOrigin: string): Page {
  const pages = context.pages();
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const page = pages[index]!;
    try {
      if (new URL(page.url()).origin === expectedOrigin) return page;
    } catch {
      // about:blank 等无有效 origin 的页面直接忽略。
    }
  }
  const actualOrigins = pages.map((page) => {
    try {
      return new URL(page.url()).origin;
    } catch {
      return 'null';
    }
  });
  throw new ShadowEdgeError(
    'E_ACCOUNT_ORIGIN_MISMATCH',
    `当前没有 ${expectedOrigin} 的页面，已拒绝填充凭据`,
    { details: { expectedOrigin, actualOrigins } },
  );
}

function assertOrigin(page: Page, expectedOrigin: string): void {
  let actualOrigin = 'null';
  try {
    actualOrigin = new URL(page.url()).origin;
  } catch {
    // 统一按 mismatch 处理。
  }
  if (actualOrigin !== expectedOrigin) {
    throw new ShadowEdgeError('E_ACCOUNT_ORIGIN_MISMATCH', '页面 origin 已变化，已停止填充', {
      details: { expectedOrigin, actualOrigin },
    });
  }
}
