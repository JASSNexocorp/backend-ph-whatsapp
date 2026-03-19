export type InteractiveReplyButton = {
  id: string;
  title: string;
};

export type OutgoingInteractiveReplyButtonsMessage = {
  kind: 'interactive_reply_buttons';
  headerImage?: { link: string };
  bodyText: string;
  footerText?: string;
  buttons: InteractiveReplyButton[];
};

export type OutgoingTextMessage = {
  kind: 'text';
  text: string;
};

export type OutgoingImageMessage = {
  kind: 'image';
  imageLink: string;
  caption?: string;
};

export type OutgoingMessage =
  | OutgoingTextMessage
  | OutgoingImageMessage
  | OutgoingInteractiveReplyButtonsMessage;

