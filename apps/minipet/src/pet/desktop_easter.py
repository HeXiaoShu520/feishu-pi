# coding:utf-8
# 彩蛋功能的统一入口模块，将各个彩蛋弹窗的创建逻辑从 DesktopPet 主类中拆出，
# 避免主类膨胀。所有函数接受 owner（DesktopPet 实例）并直接操作其属性。

from widgets.easter import CoinPopup, DicePopup, FortuneStickPopup, GachaPopup, MagicConchPopup, WoodenFishPopup
from widgets.menus.pet_menus import PetEasterMenu


def show_easter_menu(owner):
    """弹出彩蛋主菜单；已打开则置顶，避免重复创建。"""
    if owner.quick_menu is not None:
        owner.quick_menu.close()
    if owner.easter_menu is not None and owner.easter_menu.isVisible():
        owner.easter_menu.raise_()
        return
    x, y = owner.easter_popup_anchor()
    actions = [
        ('🐚', '魔法海螺', '问一个是/否问题', owner.show_magic_conch),
        ('🎋', '今日求签', '摇一支今日运势', owner.show_fortune),
        ('🎲', '摇骰子', '交给随机数决定', owner.show_dice),
        ('res/icons/easter/coin.png', '抛硬币', '正反之间做选择', owner.show_coin),
        ('🐟', '电子木鱼', '功德 +1，Bug -1', owner.toggle_wooden_fish),
        ('🎁', '桌宠扭蛋', '胶囊里有今日惊喜', owner.show_gacha),
    ]
    owner.easter_menu = PetEasterMenu(x, y, actions, owner)
    owner.easter_menu.destroyed.connect(lambda: setattr(owner, 'easter_menu', None))


def show_game_popup(owner, attr_name, popup_class):
    """通用彩蛋弹窗入口：按属性名管理实例生命周期。"""
    # 通用弹窗开关：已有实例且可见时直接置顶，不重复创建，
    # 关闭时通过 destroyed 信号将属性置 None，避免持有已销毁 C++ 对象
    current = getattr(owner, attr_name)
    if current is not None and current.isVisible():
        current.raise_()
        return
    x, y = owner.easter_popup_anchor()
    popup = popup_class(x, y, owner)
    popup.destroyed.connect(lambda: setattr(owner, attr_name, None))
    setattr(owner, attr_name, popup)
    owner.pat()


def show_magic_conch(owner):
    """显示魔法海螺弹窗。"""
    show_game_popup(owner, 'magic_conch_popup', MagicConchPopup)


def show_gacha(owner):
    """显示桌宠扭蛋弹窗。"""
    show_game_popup(owner, 'gacha_popup', GachaPopup)


def show_dice(owner):
    """显示摇骰子弹窗。"""
    show_game_popup(owner, 'dice_popup', DicePopup)


def show_coin(owner):
    """显示抛硬币弹窗。"""
    show_game_popup(owner, 'coin_popup', CoinPopup)


def show_fortune(owner):
    """显示今日求签弹窗（单例，已存在则置顶）。"""
    if owner.fortune_stick_popup is not None and owner.fortune_stick_popup.isVisible():
        owner.fortune_stick_popup.raise_()
        return
    x, y = owner.easter_popup_anchor()
    owner.fortune_stick_popup = FortuneStickPopup(x, y, owner)
    owner.fortune_stick_popup.destroyed.connect(lambda: setattr(owner, 'fortune_stick_popup', None))
    owner.pat()


def toggle_wooden_fish(owner):
    """切换电子木鱼显示状态。"""
    # 木鱼是切换式：已显示则关闭，未显示则创建，实现"再点一次收回"的交互
    if owner.wooden_fish_popup is not None and owner.wooden_fish_popup.isVisible():
        owner.wooden_fish_popup.close()
        owner.wooden_fish_popup = None
        return
    x, y = owner.easter_popup_anchor()
    owner.wooden_fish_popup = WoodenFishPopup(x, y, owner)
    owner.wooden_fish_popup.destroyed.connect(lambda: setattr(owner, 'wooden_fish_popup', None))
