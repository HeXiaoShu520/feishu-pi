# coding:utf-8


def show_chat_window(owner, history=None, clear_history_callback=None, send_callback=None):
    from windows.chat_window import ChatWindow
    import config

    if owner.chat_window is None:
        owner.chat_window = ChatWindow(config.pet_display_name(), owner, history=history, clear_history_callback=clear_history_callback, send_callback=send_callback)
    else:
        owner.chat_window.set_pet_name(config.pet_display_name())
        owner.chat_window.clear_history_callback = clear_history_callback
        owner.chat_window.send_callback = send_callback
        if history is not None:
            if owner.chat_window.history is not history:
                owner.chat_window.history = history
            owner.chat_window.reload_history()
    owner.chat_window.show_window()
