# coding:utf-8


def show_chat_window(owner, history=None):
    from windows.chat_window import ChatWindow
    import config

    if owner.chat_window is None:
        owner.chat_window = ChatWindow(config.pet_display_name(), owner, history=history)
    else:
        owner.chat_window.set_pet_name(config.pet_display_name())
        if history is not None:
            if owner.chat_window.history is not history:
                owner.chat_window.history = history
            owner.chat_window.reload_history()
    owner.chat_window.show_window()
