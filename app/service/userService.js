const Service = require('egg').Service
const md5 = require('md5')
const _ = require('lodash')
const uuidv1 = require('uuid/v1')
const { salt } = require('../common/property')
const { USERNAME, EMAIL } = require('../common/type')

const TOKEN = 'token_'

class UserService extends Service {
  constructor(ctx) {
    super(ctx)
    this.UserModel = ctx.model.UserModel
    this.ServerResponse = ctx.response.ServerResponse
  }
  /**
   *
   * @param field {String}
   * @param value {String}
   * @returns {Promise.<boolean>}
   */
  async _checkExistColByField(field, value) {
    const data = await this.UserModel.findOne({
      attributes: [field],
      where: { [field]: value }
    })
    return !!data
  }

  /**
   * @feature 校验 username email
   * @param value {String}
   * @param type {String}
   * @return ServerResponse.msg
   */
  async _checkValid(type, value) {
    if (type.trim()) {
      if (USERNAME === type) return await this._checkExistColByField(USERNAME, value)
        ? this.ServerResponse.createByErrorMsg('用户名已存在')
        : this.ServerResponse.createBySuccessMsg('用户名不存在')
      if (EMAIL === type) return await this._checkExistColByField(EMAIL, value)
        ? this.ServerResponse.createByErrorMsg('邮箱已存在')
        : this.ServerResponse.createBySuccessMsg('邮箱不存在')
    }
    return this.ServerResponse.createByErrorMsg('参数错误')
  }

  async login(username, password) {
    // 用户名存在报错
    const validResponse = await this._checkValid(USERNAME, username)
    if (validResponse.isSuccess()) return validResponse

    // 检查密码是否正确
    const user = await this.UserModel.findOne({
        attributes: ['id', 'username', 'email', 'phone'],
        where: {
          username,
          password: md5(password + salt)
        }
      })

    if (!user) return this.ServerResponse.createByErrorMsg('密码错误')

    return this.ServerResponse.createBySuccessMsgAndData('登录成功', user.toJSON())
  }

  /**
   *
   * @param user {Object} { username, password, ... }
   * @returns {Promise.<void>}
   */
  async register(user) {
    // 用户名存在报错
    const validUsernameResponse = await this._checkValid(USERNAME, user.username)
    if (!validUsernameResponse.isSuccess()) return validUsernameResponse
    // 邮箱存在报错
    const validEmailResponse = await this._checkValid(EMAIL, user.email)
    if (!validEmailResponse.isSuccess()) return validEmailResponse

    try {
      user.password = md5(user.password + salt)
      user = await this.UserModel.create(user, {
        attributes: { exclude: ['password', 'role', 'answer'] }
      })
      if (!user) return this.ServerResponse.createByErrorMsg('注册失败')
      else {
        user = user.toJSON()
        _.unset(user, 'password')
      }
      return this.ServerResponse.createBySuccessMsgAndData('注册成功', user)
    } catch(e) {
      console.log(e)
      return this.ServerResponse.createByErrorMsg('注册失败')
    }
  }

  async selectQuestion(username) {
    const validResponse = await this._checkValid(USERNAME, username)
    if (validResponse.isSuccess()) return this.ServerResponse.createByErrorMsg('用户不存在')
    const question = await this.UserModel.findOne({
      attributes: ['question'],
      where: {username}
    })
    if (question) return this.ServerResponse.createBySuccessData(question)
    return this.ServerResponse.createByErrorMsg('找回密码的问题是空的')
  }

  // 找回密码答案验证tokan
  async checkAnswer(username, question, answer) {
    const user = this.UserModel.findOne({
      attributes: ['username', 'question', 'answer'],
      where: { username, question, answer }
    })
    if (user) {
      // 答案正确
      const forgetToken = uuidv1()
      await this.app.redis.set(TOKEN + username, forgetToken)
      await this.app.redis.expire(TOKEN + username, 12 * 60 * 60)
      return this.ServerResponse.createBySuccessMsgAndData('问题回答正确', { token: forgetToken })
    }
    return this.ServerResponse.createByErrorMsg('问题的答案错误')
  }

  /**
   * @feature 重置密码
   * @param username {String}
   * @param passwordNew {String}
   * @param forgetToken {String}
   * @returns ServerResponse
   */
  async forgetRestPassword(username, passwordNew, forgetToken) {
    if (!forgetToken) return this.ServerResponse.createByErrorMsg('参数错误，token必须传递')
    // 用户不存在
    const validResponse = await this._checkValid(USERNAME, username)
    if (validResponse.isSuccess()) return this.ServerResponse.createByErrorMsg('用户不存在')
    // token缓存
    const token = await this.app.redis.get(TOKEN + username)
    if (!token) return this.ServerResponse.createByErrorMsg('token无效或者过期')
    // 比较token
    if (_.eq(token, forgetToken)) {
      // 修改密码
      const [rowCount] = await this.UserModel.update({
        password: md5(passwordNew + salt)
      }, { where: { username }, individualHooks: true })
      if (rowCount > 0) return this.ServerResponse.createBySuccessMsg('修改密码成功')
      else return this.ServerResponse.createBySuccessMsg('修改密码失败')
    } else return this.ServerResponse.createBySuccessMsg('token错误, 请重新获取充值密码的token')
  }

  /**
   * @feature 在线修改密码
   * @param passwordOld {String}
   * @param passwordNew {String}
   * @param currentUser {Object} [id]: 防止横向越权
   * @returns ServerResponse
   */
  async resetPassword(passwordOld, passwordNew, currentUser) {
    const result = await this.UserModel.findOne({
      attributes: ['username'],
      where: { id: currentUser.id, password: md5(passwordOld + salt) }
    })
    if (!result) return this.ServerResponse.createByErrorMsg('旧密码错误')
    const [rowCount] = await this.UserModel.update({
      password: md5(passwordNew + salt)
    }, { where: { username: currentUser.username }, individualHooks: true })
    if (rowCount > 0) return this.ServerResponse.createBySuccessMsg('修改密码成功')
    return this.ServerResponse.createByErrorMsg('更新密码失败')
  }

  /**
   * @feature 更新用户信息
   * @param userInfo
   * @param currentUser
   * @returns {Promise.<ServerResponse>}
   */
  async updateUserInfo(userInfo, currentUser) {
    // username 不能被更新
    // email 校验email 是否存在，并且email 存在不是当前currentUser
    const result = await this.UserModel.findOne({
      attributes: ['email'],
      where: {
        email: userInfo.email,
        id: { '$not': currentUser.id }
        // '$not': [ { id: currentUser.id } ]
      }
    })
    if (result) return this.ServerResponse.createByErrorMsg('email已经存在, 请更换')
    const [updateCount, [updateRow]] = await this.UserModel.update(userInfo, {
      where: { id: currentUser.id },
      individualHooks: true
    })
    const user = _.pickBy(updateRow.toJSON(), (value, key) => {
      return ['id', 'username', 'email', 'phone'].find(item => key === item)
    })
    if (updateCount > 0) return this.ServerResponse.createBySuccessMsgAndData('更新个人信息成功', user)
    return this.ServerResponse.createByError('更新个人信息失败')
  }

  /**
   * 获取用户信息
   * @param {String} userId session下的 id
   * @returns {Promise.<void>}
   */
  async getUserInfo(userId) {
    const user = await this.UserModel.findOne({
      attributes: ['id', 'username', 'email', 'phone', 'question'],
      where: { id: userId }
    })
    if (!user) return this.ServerResponse.createByErrorMsg('找不到当前用户')
    return this.ServerResponse.createBySuccessData(user.toJSON())
  }
}

module.exports = UserService
