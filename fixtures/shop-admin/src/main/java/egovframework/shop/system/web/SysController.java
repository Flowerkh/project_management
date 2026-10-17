package egovframework.shop.system.web;

import javax.annotation.Resource;
import org.springframework.stereotype.Controller;
import org.springframework.ui.ModelMap;
import org.springframework.web.bind.annotation.*;
import egovframework.shop.system.service.SysService;
import egovframework.shop.system.service.SysVO;

@Controller
@RequestMapping("/system")
public class SysController {

    @Resource(name = "sysservice")
    private SysService sysservice;

    /** 메뉴 관리 화면 */
    @RequestMapping("/menuList.do")
    public String menuList(@ModelAttribute("searchVO") SysVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectMenuList", sysservice.selectMenuList(vo));
        return "shop/system/menuList";
    }

    /** 메뉴 관리: insertMenu (ajax) */
    @RequestMapping(value = "/insertMenu.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> insertMenu(SysVO vo) throws Exception {
        sysservice.insertMenu(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 메뉴 관리: deleteMenu (ajax) */
    @RequestMapping(value = "/deleteMenu.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> deleteMenu(SysVO vo) throws Exception {
        sysservice.deleteMenu(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 공통코드 관리 화면 */
    @RequestMapping("/codeList.do")
    public String codeList(@ModelAttribute("searchVO") SysVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectCodeList", sysservice.selectCodeList(vo));
        return "shop/system/codeList";
    }

    /** 공통코드 관리: mergeCodeDetail (ajax) */
    @RequestMapping(value = "/mergeCodeDetail.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> mergeCodeDetail(SysVO vo) throws Exception {
        sysservice.mergeCodeDetail(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 관리자 계정 화면 */
    @RequestMapping("/adminList.do")
    public String adminList(@ModelAttribute("searchVO") SysVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectAdminList", sysservice.selectAdminList(vo));
        return "shop/system/adminList";
    }

    /** 관리자 계정: updateAdminAuth (ajax) */
    @RequestMapping(value = "/updateAdminAuth.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> updateAdminAuth(SysVO vo) throws Exception {
        sysservice.updateAdminAuth(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 접속 로그 화면 */
    @RequestMapping("/loginLogList.do")
    public String loginLogList(@ModelAttribute("searchVO") SysVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectLoginLogList", sysservice.selectLoginLogList(vo));
        return "shop/system/loginLogList";
    }

    /** 동적 조회 화면 */
    @RequestMapping("/dynamicReport.do")
    public String dynamicReport(@ModelAttribute("searchVO") SysVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectDynamic", sysservice.selectDynamic(vo));
        return "shop/system/dynamicReport";
    }

}
