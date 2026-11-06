import {
  BottomSheet,
  Button,
  Form,
  HStack,
  Host,
  List,
  NavigationStack,
  ProgressView,
  SecureField,
  Section,
  Spacer,
  Text,
  TextField,
  Toolbar,
  ToolbarItem,
} from "@expo/ui/swift-ui";
import {
  autocorrectionDisabled,
  disabled,
  keyboardType,
  labelStyle,
  navigationTitle,
  onSubmit,
  submitLabel,
  textContentType,
  textInputAutocapitalization,
} from "@expo/ui/swift-ui/modifiers";
import { useEffect, useState } from "react";
import { preferredLocalizations } from "@swipt/api/localization";
import { actions, exit } from "@swipt/api/swiplet";

import locales from "../locales.json";
import type extension from "./extension";
import { readAccounts, writeAccounts, type Account } from "./storage";

const table: Record<string, Partial<typeof locales.en>> = locales;
const strings: typeof locales.en = Object.assign(
  {},
  locales.en,
  ...preferredLocalizations(Object.keys(locales))
    .map((localization) => table[localization])
    .reverse(),
);

const { switchAccount } = actions<typeof extension>();

const device = "";

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [adding, setAdding] = useState(false);
  const [sheet, setSheet] = useState(0);
  const [switching, setSwitching] = useState<string | null>(null);
  useEffect(() => {
    readAccounts().then(setAccounts, (error: Error) => console.error(error));
  }, []);
  const save = (next: Account[]) => {
    setAccounts(next);
    writeAccounts(next).catch((error: Error) => console.error(error));
  };
  const add = (account: Account) => {
    save([
      ...accounts.filter(
        (it) => it.email.toLowerCase() !== account.email.toLowerCase(),
      ),
      account,
    ]);
    setAdding(false);
  };
  const openAdd = () => {
    setSheet(sheet + 1);
    setAdding(true);
  };
  const run = (email: string) => {
    setSwitching(email);
    switchAccount(email === device ? undefined : { email })
      .catch(reportError)
      .finally(() => setSwitching(null));
  };
  const row = (email: string, title: string) => (
    <Button
      key={email}
      onPress={() => run(email)}
      modifiers={[disabled(switching !== null)]}
    >
      <HStack>
        <Text>{title}</Text>
        <Spacer />
        {switching === email ? <ProgressView /> : null}
      </HStack>
    </Button>
  );
  return (
    <Host style={{ flex: 1 }}>
      <NavigationStack>
        <Toolbar modifiers={[navigationTitle(strings.title)]}>
          <Form>
            <Section
              header={
                <HStack>
                  <Text>{strings.accounts}</Text>
                  <Spacer />
                  <Button
                    label={strings.add}
                    systemImage="plus"
                    onPress={openAdd}
                    modifiers={[labelStyle("iconOnly")]}
                  />
                </HStack>
              }
            >
              {row(device, strings.deviceAccount)}
              <List.ForEach
                onDelete={(indices) =>
                  save(accounts.filter((_, index) => !indices.includes(index)))
                }
              >
                {accounts.map((account) => row(account.email, account.email))}
              </List.ForEach>
            </Section>
          </Form>
          <Toolbar.Content>
            <ToolbarItem placement="topBarLeading">
              <Button
                label={strings.back}
                systemImage="chevron.left"
                onPress={exit}
              />
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>
        <BottomSheet isPresented={adding} onIsPresentedChange={setAdding}>
          <AddAccount
            key={sheet}
            onAdd={add}
            onCancel={() => setAdding(false)}
          />
        </BottomSheet>
      </NavigationStack>
    </Host>
  );
}

function AddAccount({
  onAdd,
  onCancel,
}: {
  onAdd: (account: Account) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const ready = email.trim() !== "" && password !== "";
  const add = () => {
    if (ready) {
      onAdd({ email: email.trim(), password });
    }
  };
  return (
    <NavigationStack>
      <Toolbar modifiers={[navigationTitle(strings.addAccount)]}>
        <Form>
          <Section>
            <TextField
              placeholder={strings.email}
              autoFocus
              onTextChange={setEmail}
              modifiers={[
                keyboardType("email-address"),
                textContentType("username"),
                textInputAutocapitalization("never"),
                autocorrectionDisabled(),
                submitLabel("next"),
              ]}
            />
            <SecureField
              placeholder={strings.password}
              onTextChange={setPassword}
              modifiers={[
                textContentType("password"),
                submitLabel("done"),
                onSubmit(add),
              ]}
            />
          </Section>
        </Form>
        <Toolbar.Content>
          <ToolbarItem placement="cancellationAction">
            <Button label={strings.cancel} onPress={onCancel} />
          </ToolbarItem>
          <ToolbarItem placement="confirmationAction">
            <Button
              label={strings.add}
              onPress={add}
              modifiers={[disabled(!ready)]}
            />
          </ToolbarItem>
        </Toolbar.Content>
      </Toolbar>
    </NavigationStack>
  );
}
