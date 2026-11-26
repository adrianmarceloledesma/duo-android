import { Modal } from 'react-native';
import type { ModalProps } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export function SafeAreaModal({ children, ...props }: ModalProps) {
  return <Modal {...props} statusBarTranslucent navigationBarTranslucent>
    <SafeAreaProvider>{children}</SafeAreaProvider>
  </Modal>;
}
