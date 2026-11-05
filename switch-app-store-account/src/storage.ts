import { dataDirectory } from "@swipt/api/file-system";

export interface Account {
  email: string;
  password: string;
}

export const readAccounts = async (): Promise<Account[]> => {
  try {
    return JSON.parse(
      await dataDirectory.file("accounts.json").text(),
    ) as Account[];
  } catch {
    return [];
  }
};

export const writeAccounts = (accounts: Account[]) =>
  dataDirectory.file("accounts.json").write(JSON.stringify(accounts));
